#!/usr/bin/env bash
# Phase 2E3C5D4: synthetic release failure/reconciliation test ONLY.
# NO DDL, dumps, seed data or roles are written to the working database.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT || true
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -f .env ]] || fail 'Reviewed local .env missing'
for tool in node sudo psql pg_config sha256sum mktemp git python3 cmp timeout env; do
  command -v "$tool" >/dev/null || fail "Missing prerequisite: $tool"
done
node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw || process.env.NODE_ENV === 'production') throw Error('Production/missing DB refused');
const u = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(u.username) !== 'pulse_metrics_app') {
  throw Error('Only reviewed local development runtime configuration allowed');
}
console.log('PASS: local development-only runtime identity');
NODE
node scripts/migrations/verify-manifest.mjs
# Only read-only commands in the original developer PostgreSQL cluster.
bash scripts/migrations/audit-adoption-drift.sh
BASELINE='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
MAIN_VERSION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics \
  -c "SELECT current_setting('server_version_num')")" || fail 'Local server version unavailable'
[[ "$MAIN_VERSION" =~ ^[0-9]{5,6}$ ]] || fail 'Invalid PostgreSQL version'
MAJOR="$((MAIN_VERSION / 10000))"
PG_BIN="$(pg_config --bindir)"
if [[ -x "/usr/lib/postgresql/$MAJOR/bin/initdb" ]]; then
  PG_BIN="/usr/lib/postgresql/$MAJOR/bin"
fi
for tool in initdb pg_ctl postgres psql createdb; do
  [[ -x "$PG_BIN/$tool" ]] || fail "Missing matched PostgreSQL binary $tool"
done
VERSION_TEXT="$("$PG_BIN/postgres" --version)"
if [[ "$VERSION_TEXT" =~ PostgreSQL\)?[[:space:]]+([0-9]+)([.]|$) ]]; then
  [[ "${BASH_REMATCH[1]}" == "$MAJOR" ]] || fail 'PostgreSQL major differs'
else
  fail 'Unexpected PostgreSQL version string'
fi
[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ && "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
  fail 'Unexpected OS user or group'
BASE=''; DATA=''; SOCKET=''; PORT=55432
cleanup() {
  local code=$? stopped=1
  trap - EXIT
  set +e
  if [[ -n "$BASE" && "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
     sudo -u postgres test -f "$BASE/.pulse-release-lock-marker"; then
    echo '========== STOP DISPOSABLE FAILURE-RECOVERY CLUSTER =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null 2>&1 ||
        sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || stopped=0
    fi
    if [[ "$stopped" -eq 1 ]] &&
       ! sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres rm -rf -- "$BASE" || stopped=0
    else
      stopped=0
    fi
    if [[ "$stopped" -eq 0 ]]; then
      echo "CRITICAL: isolated PostgreSQL cluster retained at $BASE; inspect manually" >&2
      code=1
    else
      echo 'PASS: temporary cluster, simulated records and recovery artifacts removed'
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] || fail 'Invalid temporary cluster path'
DATA="$BASE/data"
SOCKET="$BASE/socket"
sudo -u postgres touch "$BASE/.pulse-release-lock-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"
sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

echo '========== BOOTSTRAP ISOLATED FAILURE-RECOVERY CLUSTER =========='
sudo -u postgres "$PG_BIN/initdb" -D "$DATA" --username=postgres \
  --auth-local=peer --auth-host=reject --no-instructions >/dev/null
sudo -u postgres tee "$DATA/pg_ident.conf" >/dev/null <<IDENT
pulse_release $(id -un) pulse_metrics_migrator
pulse_release $(id -un) pulse_metrics_app
IDENT
sudo -u postgres tee "$DATA/pg_hba.conf" >/dev/null <<'HBA'
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_release
local pulse_metrics pulse_metrics_app peer map=pulse_release
local all all reject
host all all 0.0.0.0/0 reject
host all all ::/0 reject
HBA
sudo -u postgres tee -a "$DATA/postgresql.conf" >/dev/null <<CONFIG
listen_addresses = ''
port = $PORT
unix_socket_directories = '$SOCKET'
unix_socket_permissions = 0777
logging_collector = off
CONFIG
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/start.log" -w start >/dev/null
ID="$(sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At \
  -h "$SOCKET" -p "$PORT" -U postgres -d postgres -c \
  "SELECT current_setting('data_directory') || '|' || current_user || '|' || \
  (inet_server_addr() IS NULL)::text || '|' || (current_setting('listen_addresses')='')::text")"
[[ "$ID" == "$DATA|postgres|true|true" ]] || fail 'Isolated socket, role or data directory not verified'
echo 'PASS: independent marked data directory, peer Unix socket, TCP-disabled server verified'
psql_admin() {
  local db="$1"; shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$db" "$@"
}
psql_admin postgres -q < scripts/replay/bootstrap-roles.sql
sudo -u postgres "$PG_BIN/createdb" -h "$SOCKET" -p "$PORT" -U postgres -O postgres pulse_metrics
psql_admin pulse_metrics -q < scripts/replay/bootstrap-database.sql
PULSE_REPLAY_SOCKET="$SOCKET" PULSE_REPLAY_DATA="$DATA" PULSE_REPLAY_PORT="$PORT" \
  node scripts/replay/migrate-isolated.mjs
psql_admin pulse_metrics -q < scripts/replay/runtime-grants.sql
psql_admin pulse_metrics -q < scripts/migrations/ledger-bootstrap.sql
STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)" || fail 'Cannot validate reviewed SQL manifest'
[[ "$(printf '%s\n' "$STEPS" | wc -l)" -eq 6 ]] || fail 'Expected exactly six reviewed SQL sources'
while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ && "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ &&
    "$source" == scripts/admin/${version}_* && "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'Invalid privileged SQL manifest record'
  {
    printf 'BEGIN READ ONLY;\n'
    printf "SELECT set_config('pulse.replay_step_version','%s',true);\n" "$version"
    cat scripts/migrations/step-preflight-assert.sql
    printf 'COMMIT;\n'
  } | psql_admin pulse_metrics -q >/dev/null
  psql_admin pulse_metrics -q < "$source"
  psql_admin pulse_metrics -q -v "version=$version" -v "source_path=$source" \
    -v "digest=$digest" < scripts/migrations/ledger-record.sql
  echo "RECORDED reviewed privileged step $version in disposable cluster"
done <<< "$STEPS"
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
ORIGINAL_CATALOG="$(psql_admin pulse_metrics -Atq < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$ORIGINAL_CATALOG" == "$BASELINE" ]] || fail 'Pre-release public security fingerprint mismatch'
psql_admin pulse_metrics -q < scripts/release/rehearsal-control-bootstrap.sql

# The shell's superuser verified data_directory; the client stays least-privileged.
MIGRATOR_ID="$("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_migrator -d pulse_metrics -c \
  "SELECT current_user || '|' || current_database() || '|' || (inet_server_addr() IS NULL)::text")"
[[ "$MIGRATOR_ID" == 'pulse_metrics_migrator|pulse_metrics|true' ]] ||
  fail 'Unprivileged migrator identity check failed'

echo '========== TEST INTERRUPTION, UNKNOWN COMMIT AND MANUAL RETRY GATES =========='
# Bound the integration exercise, so a stalled test cannot hold the cluster forever.
timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_RELEASE_DISPOSABLE_ONLY=YES PULSE_RELEASE_SOCKET="$SOCKET" PULSE_RELEASE_DATA="$DATA" \
  node scripts/release/recovery-integration.mjs

echo '========== VERIFY FINAL ISOLATED SECURITY INVARIANTS =========='
psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;
DO $check$
BEGIN
 IF current_database()<>'pulse_metrics' OR current_user<>'postgres'
    OR (SELECT count(*) FROM pulse_release_rehearsal.release_receipts)<>1
    OR (SELECT count(*) FROM pulse_release_rehearsal.applied_canary)<>1
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6
    OR (SELECT count(*) FROM public.__drizzle_migrations)<>1
    OR has_schema_privilege('pulse_metrics_app','pulse_release_rehearsal','USAGE')
    OR has_table_privilege('pulse_metrics_app','pulse_release_rehearsal.release_receipts','SELECT')
    OR has_table_privilege('pulse_metrics_migrator','pulse_release_rehearsal.release_receipts','DELETE')
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='pulse_release_rehearsal.release_receipts'::regclass
      AND relrowsecurity AND relforcerowsecurity AND relowner='postgres'::regrole) THEN
   RAISE EXCEPTION 'RECOVERY_REHEARSAL_AUDIT: role, RLS, ledger or row count invalid';
 END IF;
 RAISE NOTICE 'PASS: single durable receipt/canary, historic ledgers intact, forced RLS, no ordinary app access';
END;
$check$;
COMMIT;
SQL
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
AFTER_CATALOG="$(psql_admin pulse_metrics -Atq < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$AFTER_CATALOG" == "$BASELINE" ]] || fail 'Public catalog drifted after recovery rehearsal'
for statement in \
  'SELECT * FROM pulse_release_rehearsal.release_receipts LIMIT 1' \
  'SELECT * FROM public.agent_credentials LIMIT 1' \
  'SELECT * FROM pulse_security_migrations.applied_privileged_steps LIMIT 1' \
  'CREATE TABLE public.recovery_forbidden (id integer)'; do
  if "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
    -U pulse_metrics_app -d pulse_metrics -c "$statement" >/dev/null 2>&1; then
    fail 'Restricted runtime role gained forbidden access'
  fi
done
echo 'PASS: restricted runtime cannot read private receipts, secrets or create schema objects'
LAST_MAIN="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$LAST_MAIN" == "$BASELINE" ]] || fail 'Original development database catalog changed'
echo 'PASS: existing developer database structural catalog remained unchanged'
echo '========== PHASE 2E3C5D4 RELEASE FAILURE RECOVERY REHEARSAL COMPLETED =========='
echo 'NOTE: synthetic keys only; simulated lost client acknowledgement after COMMIT was already accepted'
echo 'NOTE: does not prove recovery from real network outage mid-COMMIT, production operator custody or WAL/PITR'
