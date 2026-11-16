#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F2F: NONZERO DATA READ-ONLY AUDIT, DISPOSABLE ONLY.
# Does not initialize, start, stop, enroll, issue, revoke or write to PostgreSQL.
# Never targets the retained backup or persistent local cluster on port 55433.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2F2F: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 && ( "$1" == --plan || "$1" == --audit-disposable ) ]] ||
  refuse 'Use exactly --plan or --audit-disposable'
MODE="$1"
[[ "$(uname -s)" == Linux && "$(id -u)" -ne 0 ]] || refuse 'Linux non-root required'
[[ "${NODE_ENV:-development}" == development ]] || refuse 'Only development environment allowed'
[[ -z "${NODE_OPTIONS:-}" && -z "${NODE_EXTRA_CA_CERTS:-}" ]] || refuse 'Inherited Node startup/trust options refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-1}" != 0 ]] || refuse 'TLS bypass is forbidden'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited database URLs refused'
[[ "${PULSE_ENABLE_PUBLIC_INGRESS:-}" != YES && "${PULSE_ENABLE_TELEMETRY_SERVICE:-}" != YES ]] || refuse 'Service flags refused'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
SQL='scripts/telemetry-persistent/nonzero-pilot-ledger.sql'
SQL_SHA='c7861e43faae020a5e8d4de0f83509a277c1960694369a7db90631f7d5a9f862'
[[ -f "$SQL" && ! -L "$SQL" ]] || refuse 'Missing or linked reviewed SQL'
command -v sha256sum >/dev/null 2>&1 || refuse 'SHA256 required'
[[ "$(sha256sum "$SQL" | cut -d ' ' -f1)" == "$SQL_SHA" ]] || refuse 'Reviewed SQL changed'

if [[ "$MODE" == --plan ]]; then
  echo '========== D15C-5U-2F2F NONZERO PILOT AUDIT PLAN =========='
  echo 'Audit ONLY the currently running D15C-5T disposable PostgreSQL 16 cluster on private socket/port 55432.'
  echo 'Require exactly 246 submission-linked telemetry rows, including two genuine Linux measurements.'
  echo 'Check forced RLS, original migration receipts, restricted grants, tenant/agent ownership and revocation.'
  echo 'Use a single BEGIN READ ONLY transaction. Never start PostgreSQL, modify data or mount HTTP routes.'
  echo 'Protected persistent port 55433 and retained cold backup are NEVER accepted.'
  echo 'Not a persistent-data write approval, production operator, or launch-readiness decision.'
  exit 0
fi

[[ "${PULSE_D15C5T_ONLY:-}" == YES && "${PULSE_D15C4_DISPOSABLE_ONLY:-}" == YES &&
   "${PULSE_D15C5T_RESTART_VERIFIED:-}" == YES ]] || refuse 'Disposable post-restart admission missing'
for key in PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA; do
  [[ -z "${!key:-}" ]] || refuse "Inherited libpq override not allowed: $key"
done
SOCKET="${PULSE_D15C4_SOCKET:-}"
DATA="${PULSE_D15C4_DATA:-}"
ORG_A="${PULSE_D15C4_ORG_A:-}"
ORG_B="${PULSE_D15C4_ORG_B:-}"
[[ "$SOCKET" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$ ]] || refuse 'Not a disposable socket'
BASE="${SOCKET%/socket}"
[[ "$DATA" == "$BASE/data" ]] || refuse 'Data location mismatch'
UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
[[ "$ORG_A" =~ $UUID && "$ORG_B" =~ $UUID && "$ORG_A" != "$ORG_B" ]] || refuse 'Two distinct synthetic organization IDs required'
for bin in sudo pg_config stat grep; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing prerequisite $bin"
done
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/postgres" && -x "$PG_BIN/psql" && -x "$PG_BIN/pg_ctl" ]] || refuse 'PostgreSQL tools missing'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'PostgreSQL major 16 only'

for dir in "$BASE" "$DATA" "$SOCKET"; do
  sudo -u postgres test -d "$dir" && sudo -u postgres test ! -L "$dir" || refuse 'Missing or linked disposable location'
done
sudo -u postgres test -f "$BASE/.pulse-telemetry-agent-quota-marker" &&
  sudo -u postgres test ! -L "$BASE/.pulse-telemetry-agent-quota-marker" ||
  refuse 'Disposable rehearsal marker missing or linked'
[[ "$(sudo -u postgres stat -c '%U:%a' "$DATA")" == postgres:700 ]] || refuse 'Unexpected data permissions'
sudo -u postgres grep -Fx -- "listen_addresses = ''" "$DATA/postgresql.conf" >/dev/null || refuse 'TCP disabled configuration changed'
sudo -u postgres grep -Fx -- "unix_socket_directories = '$SOCKET'" "$DATA/postgresql.conf" >/dev/null || refuse 'Unix socket configuration changed'
sudo -u postgres grep -Fx -- 'port = 55432' "$DATA/postgresql.conf" >/dev/null || refuse 'Port configuration changed'
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1 || refuse 'Disposable PostgreSQL not running'

identity="$(sudo -u postgres "$PG_BIN/psql" -X -Atq -v ON_ERROR_STOP=1 \
  -h "$SOCKET" -p 55432 -U postgres -d postgres -c \
  "SELECT current_database() || '|' || current_user || '|' ||
          current_setting('data_directory') || '|' ||
          current_setting('unix_socket_directories') || '|' ||
          current_setting('port') || '|' ||
          (current_setting('listen_addresses')='')::text || '|' ||
          (inet_server_addr() IS NULL AND inet_server_port() IS NULL)::text")" ||
  refuse 'Administrative database identity query failed'
[[ "$identity" == "postgres|postgres|$DATA|$SOCKET|55432|true|true" ]] || refuse 'Connected to unexpected cluster'
echo '========== D15C-5U-2F2F NONZERO PILOT READ-ONLY AUDIT =========='
sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
  -v "org_a=$ORG_A" -v "org_b=$ORG_B" \
  -h "$SOCKET" -p 55432 -U postgres -d pulse_metrics < "$SQL" || refuse 'Nonzero audit rejected database state'
echo '========== D15C-5U-2F2F NONZERO LEDGER AUDIT: PASS =========='
echo 'READ-ONLY DISPOSABLE EVIDENCE ONLY | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO'
