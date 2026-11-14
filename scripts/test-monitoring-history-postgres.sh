#!/usr/bin/env bash
# D15C-5M: disposable, real PostgreSQL history-service integration rehearsal.
# This does not connect to the existing pulse_metrics database or work server.
# New temporary cluster, isolated Unix socket, no TCP, marked cleanup only.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

refuse() { echo "REFUSE_D15C5M: $*" >&2; exit 1; }
[[ "${NODE_ENV:-}" != 'production' ]] || refuse 'Production NODE_ENV not permitted'
[[ $# -eq 0 ]] || refuse 'Unexpected arguments; runner takes no options'
for bin in node sudo psql pg_config mktemp timeout sha256sum git; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing required tool: $bin"
done
[[ -d node_modules ]] || refuse 'Dependencies missing; run npm ci on adap first'

# Do not allow ambient libpq environment to redirect the isolated admin session.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT || true

node scripts/migrations/verify-manifest.mjs
node scripts/telemetry-maintenance/verify-history-contract-candidate.mjs
node scripts/monitoring-history/verify-5m-candidate.mjs

PG_BIN="$(pg_config --bindir)"
for bin in initdb pg_ctl psql createdb; do
  [[ -x "$PG_BIN/$bin" ]] || refuse "PostgreSQL server binary missing: $PG_BIN/$bin"
done
[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ ]] || refuse 'Invalid local account'
[[ "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] || refuse 'Invalid local group'

BASE=''
DATA=''
SOCKET=''
PORT=55432
cleanup() {
  local code=$? alive=0
  trap - EXIT
  set +e
  if [[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
     [[ "$DATA" == "$BASE/data" ]] && [[ "$SOCKET" == "$BASE/socket" ]] &&
     sudo -u postgres test -f "$BASE/.pulse-history-5m-marker"; then
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null 2>&1 ||
        sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || true
    fi
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      alive=1
    fi
    if [[ "$alive" -eq 0 ]]; then
      sudo -u postgres rm -rf -- "$BASE" || code=1
      echo 'PASS: isolated 5M database cluster removed'
    else
      echo "CRITICAL: 5M isolated test cluster still running at $BASE; inspect manually" >&2
      code=1
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] || refuse 'Unexpected temporary directory'
DATA="$BASE/data"
SOCKET="$BASE/socket"
sudo -u postgres touch "$BASE/.pulse-history-5m-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"
sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

echo '========== D15C-5M INITIALIZE TEMPORARY POSTGRESQL =========='
sudo -u postgres "$PG_BIN/initdb" -D "$DATA" \
  --username=postgres --auth-local=peer --auth-host=reject --no-instructions >/dev/null

sudo -u postgres tee "$DATA/pg_ident.conf" >/dev/null <<IDENT
pulse_history $(id -un) pulse_metrics_migrator
pulse_history $(id -un) pulse_metrics_app
IDENT
sudo -u postgres tee "$DATA/pg_hba.conf" >/dev/null <<'HBA'
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_history
local pulse_metrics pulse_metrics_app peer map=pulse_history
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

psql_admin() {
  local database="$1"; shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$database" "$@"
}

IDENTITY="$(psql_admin postgres -Atq -c "
  SELECT current_setting('data_directory') || '|' || current_user || '|' ||
         (inet_server_addr() IS NULL)::text || '|' ||
         (current_setting('listen_addresses') = '')::text || '|' ||
         current_setting('unix_socket_directories')
")"
[[ "$IDENTITY" == "$DATA|postgres|true|true|$SOCKET" ]] ||
  refuse 'Wrong database target; no fixture created'
echo 'PASS: exact temporary data directory, postgres administrator, Unix-only, TCP disabled'

echo '========== REPLAY REVIEWED DATABASE FOUNDATION =========='
psql_admin postgres -q < scripts/replay/bootstrap-roles.sql
sudo -u postgres "$PG_BIN/createdb" -h "$SOCKET" -p "$PORT" \
  -U postgres -O postgres pulse_metrics
psql_admin pulse_metrics -q < scripts/replay/bootstrap-database.sql
PULSE_REPLAY_SOCKET="$SOCKET" PULSE_REPLAY_DATA="$DATA" PULSE_REPLAY_PORT="$PORT" \
  node scripts/replay/migrate-isolated.mjs
psql_admin pulse_metrics -q < scripts/replay/runtime-grants.sql
psql_admin pulse_metrics -q < scripts/migrations/ledger-bootstrap.sql

STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)"
[[ "$(printf '%s\n' "$STEPS" | wc -l)" -eq 6 ]] || refuse 'Unexpected migration list'
while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ ]] || refuse 'Unexpected migration version'
  [[ "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ ]] || refuse 'Unexpected SQL path'
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || refuse 'Unexpected SQL digest'
  {
    printf 'BEGIN READ ONLY;\n'
    printf "SELECT set_config('pulse.replay_step_version','%s',true);\n" "$version"
    cat scripts/migrations/step-preflight-assert.sql
    printf 'COMMIT;\n'
  } | psql_admin pulse_metrics -q >/dev/null
  psql_admin pulse_metrics -q < "$source"
  psql_admin pulse_metrics -q -v "version=$version" -v "source_path=$source" \
    -v "digest=$digest" < scripts/migrations/ledger-record.sql
  echo "PASS: reviewed privileged SQL step $version"
done <<< "$STEPS"
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql

echo '========== INSTALL FICTIONAL FIXTURES IN TEMPORARY CLUSTER =========='
psql_admin pulse_metrics -q < scripts/monitoring-history/fixtures-5m.sql

# Node pg-connection-string interprets the host query parameter as a Unix
# socket directory. This URL points only at our random disposable socket.
export DATABASE_URL
DATABASE_URL="$(PULSE_5M_SOCKET="$SOCKET" node --input-type=module -e '
  const url = new URL("postgresql://pulse_metrics_app@localhost/pulse_metrics");
  url.searchParams.set("host", process.env.PULSE_5M_SOCKET);
  url.searchParams.set("port", "55432");
  process.stdout.write(url.toString());
')"
export DATABASE_POOL_MAX=1
export NODE_ENV=test
export PULSE_5M_SOCKET="$SOCKET"
export PULSE_5M_DATA="$DATA"

# Check that the socket is reachable under the genuinely restricted role.
# The test's first query independently checks actual current_user and socket.
echo '========== REAL APP-ROLE HISTORY AND ROUTE TEST: INITIAL =========='
PULSE_5M_PHASE=initial node --import tsx --test \
  tests/integration/monitoring-history-postgres.integration.test.ts

echo '========== REVOKE FIXTURE MEMBERSHIP (DISPOSABLE ADMIN ONLY) =========='
psql_admin pulse_metrics -q -c "
  DELETE FROM public.organization_memberships
  WHERE organization_id='00000000-0000-4000-8000-00000005a001'::uuid
    AND user_id='00000000-0000-4000-8000-00000005a101'::uuid
"

echo '========== REAL APP-ROLE HISTORY AND ROUTE TEST: REVOKED =========='
PULSE_5M_PHASE=revoked node --import tsx --test \
  tests/integration/monitoring-history-postgres.integration.test.ts

echo '========== D15C-5M REAL POSTGRESQL HISTORY: BOTH PHASES PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | no production monitoring route mounted'
