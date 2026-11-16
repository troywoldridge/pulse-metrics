#!/usr/bin/env bash
# D15C-5T: temporary TLS trust only for one Node test subprocess.
# This file is never a standalone database initializer or production launcher.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
refuse() { printf 'REFUSE_D15C5T_TLS: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Linux ]] || refuse 'Linux required'
[[ "$PWD" == "$ROOT" ]] || refuse 'unexpected project root'
[[ "${PULSE_D15C5T_ONLY:-}" == YES && "${PULSE_D15C4_DISPOSABLE_ONLY:-}" == YES ]] || refuse 'disposable admission missing'
[[ "${NODE_ENV:-development}" != production ]] || refuse 'production refused'
[[ -z "${NODE_OPTIONS:-}" && -z "${NODE_EXTRA_CA_CERTS:-}" ]] || refuse 'unexpected Node startup or trust settings'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 ]] || refuse 'TLS verification disabled'
[[ "${PULSE_D15C4_SOCKET:-}" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$ ]] || refuse 'socket not disposable'
[[ "${PULSE_D15C4_DATA:-}" == "${PULSE_D15C4_SOCKET%/socket}/data" ]] || refuse 'data directory mismatch'
[[ -f "${PULSE_D15C4_SOCKET%/socket}/.pulse-telemetry-agent-quota-marker" ]] || refuse 'disposable marker missing'
for cmd in mktemp openssl node; do command -v "$cmd" >/dev/null || refuse "missing $cmd"; done

BASE="$(mktemp -d /tmp/pulse-d15c5t-XXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-d15c5t-[A-Za-z0-9]{6}$ ]] || refuse 'temporary CA path invalid'
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "${BASE:-}" && "$BASE" =~ ^/tmp/pulse-d15c5t-[A-Za-z0-9]{6}$ &&
        -d "$BASE" && ! -L "$BASE" && -O "$BASE" ]]; then
    rm -rf -- "$BASE" || status=1
  else
    echo 'CRITICAL: could not safely remove test CA directory' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$BASE/ca.key" -out "$BASE/ca.pem" \
  -subj '/CN=Pulse Metrics disposable 5T CA' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$BASE/tls.key" -out "$BASE/tls.csr" \
  -subj '/CN=127.0.0.1' >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$BASE/tls.ext"
openssl x509 -req -in "$BASE/tls.csr" -CA "$BASE/ca.pem" \
  -CAkey "$BASE/ca.key" -CAcreateserial -out "$BASE/tls.pem" \
  -days 1 -sha256 -extfile "$BASE/tls.ext" >/dev/null 2>&1

NODE_ENV=development \
NODE_EXTRA_CA_CERTS="$BASE/ca.pem" \
PULSE_D15C5T_CA="$BASE/ca.pem" \
PULSE_D15C5T_TLS_KEY="$BASE/tls.key" \
PULSE_D15C5T_TLS_CERT="$BASE/tls.pem" \
  node --import tsx scripts/telemetry-https/verify-sender-to-postgres.mjs


# 5U-2F2E — The HTTPS process closed its test server and SQL pool. Reboot ONLY
# the still-running disposable PostgreSQL cluster; retain its real measurements.
echo '========== D15C-5U-2F2E DISPOSABLE DATABASE RESTART =========='
for binary in sudo pg_config; do command -v "$binary" >/dev/null || refuse "missing $binary"; done
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" && -x "$PG_BIN/postgres" ]] || refuse 'PostgreSQL executable identity invalid'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'PostgreSQL major 16 required'
DB_BASE="${PULSE_D15C4_SOCKET%/socket}"
[[ "$DB_BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] || refuse 'wrong disposable root'
[[ "$PULSE_D15C4_DATA" == "$DB_BASE/data" ]] || refuse 'wrong disposable data path'
sudo -u postgres test -f "$DB_BASE/.pulse-telemetry-agent-quota-marker" || refuse 'disposable DB marker missing'
sudo -u postgres test ! -L "$DB_BASE/.pulse-telemetry-agent-quota-marker" || refuse 'linked disposable marker'
sudo -u postgres test -d "$PULSE_D15C4_DATA" && sudo -u postgres test ! -L "$PULSE_D15C4_DATA" || refuse 'linked or missing test data'
sudo -u postgres test -d "$PULSE_D15C4_SOCKET" && sudo -u postgres test ! -L "$PULSE_D15C4_SOCKET" || refuse 'linked or missing test socket'
[[ "$(sudo -u postgres stat -c '%U:%a' "$PULSE_D15C4_DATA")" == postgres:700 ]] || refuse 'disposable DB ownership/mode changed'
sudo -u postgres grep -Fx -- "listen_addresses = ''" "$PULSE_D15C4_DATA/postgresql.conf" >/dev/null || refuse 'TCP listener config changed'
sudo -u postgres grep -Fx -- "unix_socket_directories = '$PULSE_D15C4_SOCKET'" "$PULSE_D15C4_DATA/postgresql.conf" >/dev/null || refuse 'Socket config changed'
sudo -u postgres grep -Fx -- 'port = 55432' "$PULSE_D15C4_DATA/postgresql.conf" >/dev/null || refuse 'Port config changed'

psql_disposable_admin() {
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -Atq \
    -h "$PULSE_D15C4_SOCKET" -p 55432 -U postgres -d "$1" "${@:2}"
}
verify_disposable_identity() {
  local identity
  identity="$(psql_disposable_admin postgres -c "
    SELECT current_database() || '|' || current_user || '|' ||
      current_setting('data_directory') || '|' ||
      current_setting('unix_socket_directories') || '|' ||
      current_setting('port') || '|' ||
      (current_setting('listen_addresses') = '')::text || '|' ||
      (inet_server_addr() IS NULL AND inet_server_port() IS NULL)::text
  ")" || refuse 'Cannot verify temporary PostgreSQL identity'
  [[ "$identity" == "postgres|postgres|$PULSE_D15C4_DATA|$PULSE_D15C4_SOCKET|55432|true|true" ]] ||
    refuse 'Temporary PostgreSQL identity or transport mismatch'
}

sudo -u postgres "$PG_BIN/pg_ctl" -D "$PULSE_D15C4_DATA" status >/dev/null 2>&1 || refuse 'Disposable server unexpectedly stopped'
verify_disposable_identity
PREVIOUS_START="$(psql_disposable_admin postgres -c 'SELECT pg_postmaster_start_time()::text')" || refuse 'No pre-restart timestamp'
[[ -n "$PREVIOUS_START" ]] || refuse 'Missing pre-restart timestamp'

# The parent rehearsal has a distinct cleanup trap for this exact /tmp cluster.
# If a restart fails, it handles emergency shutdown and guarded cleanup.
sudo -u postgres "$PG_BIN/pg_ctl" -D "$PULSE_D15C4_DATA" -m fast -w stop >/dev/null || refuse 'Disposable cluster did not stop'
if sudo -u postgres "$PG_BIN/pg_ctl" -D "$PULSE_D15C4_DATA" status >/dev/null 2>&1; then
  refuse 'Disposable server still running after stop'
fi
sudo -u postgres "$PG_BIN/pg_ctl" -D "$PULSE_D15C4_DATA" -l "$DB_BASE/restart.log" -w start >/dev/null || refuse 'Disposable restart failed'
verify_disposable_identity
NEXT_START="$(psql_disposable_admin postgres -c 'SELECT pg_postmaster_start_time()::text')" || refuse 'Missing post-restart timestamp'
[[ -n "$NEXT_START" && "$NEXT_START" != "$PREVIOUS_START" ]] || refuse 'Postmaster start time did not change'
echo 'PASS: exact disposable PostgreSQL 16 cluster restarted on original private socket, TCP disabled'

OWNER_A="$(psql_disposable_admin pulse_metrics -c "SELECT id FROM public.users WHERE auth_subject='user_agent_owner_a'")" || refuse 'Missing disposable owner A'
OWNER_B="$(psql_disposable_admin pulse_metrics -c "SELECT id FROM public.users WHERE auth_subject='user_agent_owner_b'")" || refuse 'Missing disposable owner B'
[[ "$OWNER_A" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || refuse 'Invalid fixture owner A'
[[ "$OWNER_B" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || refuse 'Invalid fixture owner B'
[[ "$OWNER_A" != "$OWNER_B" ]] || refuse 'Fixture actor collision'

# No secrets: these IDs are from synthetic, test-only database rows.
PULSE_D15C5T_RESTART_VERIFIED=YES \
PULSE_D15C5T_OWNER_A="$OWNER_A" \
PULSE_D15C5T_OWNER_B="$OWNER_B" \
  node scripts/telemetry-https/verify-pilot-after-restart.mjs

# Independently check the global inventory as postgres, not through RLS.
RESULT="$(psql_disposable_admin pulse_metrics -c "
  SELECT (SELECT count(*) FROM public.telemetry_samples)::text || '|' ||
         (SELECT count(*) FROM pulse_telemetry_ingestion.submissions)::text || '|' ||
         (SELECT count(*) FROM public.telemetry_samples
          WHERE metrics ? 'memory.total_bytes')::text
")" || refuse 'Post-restart privileged count audit failed'
[[ "$RESULT" == '246|246|2' ]] || refuse 'Persisted sample or submission ledger changed across restart'
echo 'PASS: 246 durable samples and submissions, including two genuine Linux records, survived restart'

# D15C-5U-2F2F — independent READ-ONLY nonzero ledger contract after
# the previously verified real PostgreSQL restart.  This helper can target
# only the disposable port 55432 rehearsal, never protected persistent 55433.
PULSE_D15C5T_RESTART_VERIFIED=YES \
  bash scripts/telemetry-persistent/rehearse-nonzero-pilot-audit.sh --audit-disposable
