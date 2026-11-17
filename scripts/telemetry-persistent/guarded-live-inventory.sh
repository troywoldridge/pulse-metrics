#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F2H — EMPTY ONLY live PostgreSQL inventory adapter.
# Uses the separately guarded 2F1 zero-data operator, runs pinned read-only SQL
# and validates its exact sanitized snapshot against the 2F2G empty policy.
# No persistent ingestion/enrollment/telemetry write or service is authorized.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2F2H: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 ]] || refuse 'Use exactly --plan | --verify | --exercise-empty'
case "$1" in
  --plan|--verify|--exercise-empty) MODE="$1" ;;
  *) refuse 'No bounded pilot, enrollment or write mode exists' ;;
esac
[[ "$(uname -s)" == Linux && "$(id -u)" -ne 0 ]] || refuse 'Linux non-root operator required'
[[ "${NODE_ENV:-development}" == development ]] || refuse 'Development only'
[[ -z "${NODE_OPTIONS:-}" && -z "${NODE_EXTRA_CA_CERTS:-}" ]] || refuse 'Node injection/TLS overrides refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-1}" != 0 ]] || refuse 'TLS verification bypass refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited database URLs refused'
for flag in PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA PGCONNECT_TIMEOUT; do
  [[ -z "${!flag:-}" ]] || refuse "Inherited libpq target override: $flag"
done
for flag in PULSE_ENABLE_PUBLIC_INGRESS PULSE_ENABLE_TELEMETRY_SERVICE \
  PULSE_D15C5U_LOCAL_ONLY PULSE_APPROVE_5U2F_LOCAL_START \
  PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE; do
  [[ -z "${!flag:-}" ]] || refuse "Unexpected service/approval environment: $flag"
done
if [[ "$MODE" == --exercise-empty ]]; then
  [[ "${PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY:-}" == START_READ_ONLY_SNAPSHOT_STOP ]] ||
    refuse 'Separate exact live empty-inventory approval required'
else
  [[ -z "${PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY:-}" ]] ||
    refuse 'Approval permitted only with --exercise-empty'
fi

if [[ "$MODE" == --plan ]]; then
  cat <<'PLAN'
========== D15C-5U-2F2H LIVE INVENTORY PLAN ==========
--verify: pin SQL, policy, validator and previous operators; test the complete
          parser; recheck the STOPPED protected cluster and retained backup.
--exercise-empty: independently approved 55433 private PostgreSQL 16
          zero-data START -> actual REPEATABLE READ, READ ONLY SQL inventory
          -> effective app-role RLS probe -> exact 2F2G EMPTY policy -> AUDIT
          -> mandatory targeted STOP -> stopped-source and retained-backup recheck.
The SQL refuses ANY operational rows, including private quota/audit/token rows.
No credentials/hashes are emitted; no bounded policy/tenant ID is selectable.
The original protected operator and same-host retained recovery backup are
never modified; no migration, ready marker, public route or persistent write.
NO DATABASE STARTED BY PLAN | PERSISTENT WRITES: NOT APPROVED | PUBLIC LAUNCH: NO_GO
PLAN
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ "$ROOT" == "$HOME/Projects/pulse-metrics" ]] || refuse 'Unexpected project location'
cd "$ROOT"
[[ "$(git branch --show-current)" == feat/identity-organization-onboarding ]] ||
  refuse 'Unexpected Git branch'
for bin in git sudo sha256sum cut bash node pg_config flock; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing dependency: $bin"
done
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/psql" && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/postgres" ]] ||
  refuse 'PostgreSQL binaries missing'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'PostgreSQL 16 only'

BASE='/var/lib/postgresql/pulse-metrics-dev-5u2'
DATA="$BASE/data"
SOCKET="$BASE/socket"
PORT=55433
OLD='scripts/telemetry-persistent/local-development-postgres.sh'
GUARD='scripts/telemetry-persistent/guarded-persistent-pilot.sh'
POLICY='scripts/telemetry-persistent/pilot-inventory-policy.mjs'
TEST='scripts/telemetry-persistent/live-pilot-inventory.test.mjs'
SQL='scripts/telemetry-persistent/pilot-live-inventory.sql'
VALIDATOR='scripts/telemetry-persistent/validate-live-pilot-inventory.mjs'
BACKUP='scripts/telemetry-persistent/retained-local-cold-snapshot.sh'
OFFLINE='scripts/telemetry-dev/inspect-incomplete-persistent-development.sh'

pin() {
  local file="$1" expected="$2" actual
  [[ -f "$file" && ! -L "$file" ]] || refuse "Missing/linked source: $file"
  actual="$(sha256sum "$file" | cut -d' ' -f1)" || refuse "Hash failed: $file"
  [[ "$actual" == "$expected" ]] || refuse "Source differs from reviewed bytes: $file"
  printf 'PASS: pinned %s\n' "$file"
}
pin "$OLD" '6286727b0ee8720a539f46aa2f87b87c84c013afd782099ba8bceae6ded34c3b'
pin "$GUARD" 'b81e5c0c4ceda47a2c2f9a5c0fd4c8dd158895c7519290ff914204241b289e6a'
pin "$POLICY" '332c10803dbf674c2ad31e6fe2c44ac9c143f296228b430853fe416a73ed1a41'
pin "$BACKUP" '2e4c2d09044e85bc7b20ee3de451b549b958580ccf80c957fcf303bb5414d904'
pin "$OFFLINE" '7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'
pin "$SQL" '9c615fec37b03276bcefe46e9224e2e26e1434b5719d096fe25edc6cf890c713'
pin "$VALIDATOR" '2ed0add299167d54db960502438ca908d223cddd0a1badab275dd6690d3b3474'
[[ -f "$TEST" && ! -L "$TEST" ]] || refuse 'Offline inventory tests missing or linked'

bash -n "$OLD"
node --check "$VALIDATOR"
# Neither the live approval nor local start approval may be inherited by
# negative tests, including recursive operator subprocesses.
env -u PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY \
    -u PULSE_APPROVE_5U2F_LOCAL_START \
  node --test "$TEST" || refuse 'Inventory regression tests failed'

# The already-verified guarded operator independently checks the pinned
# original database, migrations, backup, source identities and its tests.
env -u PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY \
  bash "$GUARD" --verify || refuse 'Frozen development preflight failed'
echo '========== D15C-5U-2F2H LIVE INVENTORY VERIFY: PASS =========='
if [[ "$MODE" == --verify ]]; then
  echo 'NO DATABASE STARTED | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO'
  exit 0
fi

# Lock the operator's existing inode, without creating or deleting files.
# This serializes 2F2H invocations. The existing 2F1 start guard independently
# refuses an already-running cluster. FD 9 is also our pinned SQL source.
# The invoking operator opens the private home-directory file; the postgres
# OS account cannot traverse that directory and must NOT use psql -f.
exec 9< "$SQL"
flock -n 9 || refuse 'Another 2F2H audit has locked the source'
START_ATTEMPTED=0
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if (( START_ATTEMPTED )); then
    echo '========== 2F2H MANDATORY TARGETED STOP / RECOVERY VERIFICATION =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      bash "$OLD" --stop || code=1
    fi
    bash "$OFFLINE" || code=1
    bash "$BACKUP" --verify || code=1
  fi
  (( code == 0 )) || printf 'CRITICAL: 2F2H audit or shutdown failed; inspect before retry\n' >&2
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bash "$OFFLINE" || refuse 'Original quarantined cluster not safely stopped'
START_ATTEMPTED=1
PULSE_APPROVE_5U2F_LOCAL_START=EXACT_SOCKET_ONLY bash "$OLD" --start ||
  refuse 'Original zero-row-only guarded startup failed'

sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1 ||
  refuse 'Exact development cluster not running after guarded start'

echo '========== D15C-5U-2F2H ACTUAL READ-ONLY POSTGRESQL INVENTORY =========='
# -X skips .psqlrc; -Atq yields exactly one JSON record; -v aborts on SQL
# errors. The captured JSON is never printed and contains no credential hashes.
# Feed the already-open, locked SQL descriptor as stdin. The shell duplicates
# FD 9 into stdin BEFORE sudo switches to the postgres OS account, avoiding
# directory traversal permissions while retaining the exact pinned inode.
# Never use psql -f "$SQL"; that would reopen the private path as postgres.
INVENTORY="$(sudo -u postgres "$PG_BIN/psql" -X -Atq \
  -v ON_ERROR_STOP=1 -P pager=off \
  -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics \
  <&9)" || refuse 'Live read-only PostgreSQL inventory query failed'
printf '%s\n' "$INVENTORY" | node "$VALIDATOR" --empty-stdin ||
  refuse 'Live snapshot rejected by independent 2F2G empty policy'

bash "$OLD" --audit || refuse 'Original zero-row security audit failed after snapshot'
echo '========== D15C-5U-2F2H LIVE EMPTY INVENTORY AUDIT: PASS =========='
echo 'Actual PostgreSQL inventory + effective RLS + empty policy verified; mandatory stop follows.'
echo 'PERSISTENT TELEMETRY WRITES: NOT APPROVED | PUBLIC LAUNCH: NO_GO'
