#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F2D — persistent telemetry pilot PREPARATION only.
# Does not authorize enrollment, telemetry writes, ingress, API or production.
# --verify checks ONLY the stopped quarantined source and the retained backup.
# --audit performs a guarded START / READ-ONLY AUDIT / STOP of the same source.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2F2D: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 ]] || refuse 'Use exactly --plan, --verify or --audit'
case "$1" in
  --plan|--verify|--audit) MODE="$1" ;;
  *) refuse 'Use exactly --plan, --verify or --audit' ;;
esac
[[ "$(uname -s)" == Linux && "$(id -u)" -ne 0 ]] || refuse 'Non-root Linux operator required'
[[ "${NODE_ENV:-development}" != production && -z "${NODE_OPTIONS:-}" ]] || refuse 'Production or injected Node startup refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited database URLs refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 && -z "${NODE_EXTRA_CA_CERTS:-}" ]] || refuse 'Inherited TLS trust override refused'
[[ -z "${PULSE_ENABLE_PUBLIC_INGRESS:-}" && -z "${PULSE_ENABLE_TELEMETRY_SERVICE:-}" && -z "${PULSE_D15C5U_LOCAL_ONLY:-}" ]] || refuse 'Service, sender and public ingress activation refused'
if [[ "$MODE" == --audit ]]; then
  [[ "${PULSE_APPROVE_5U2F2D_READ_ONLY_AUDIT:-}" == 'START_AUDIT_STOP_ZERO_ROWS' ]] || refuse 'Separate START_AUDIT_STOP_ZERO_ROWS approval required'
fi

# A plan is available without sudo, PostgreSQL or touching any source files.
if [[ "$MODE" == --plan ]]; then
  cat <<'PLAN'
========== D15C-5U-2F2D PERSISTENT PILOT PREPARATION PLAN ==========
Target: ONLY the quarantined development PostgreSQL 16 cluster on private port 55433.
--verify: check exact source code fingerprints, pinned migration candidates,
          stopped source identity and the independently verified retained backup.
--audit: additionally start this exact database, perform the existing zero-row
         security audit, and stop it; shutdown is mandatory even on failure.
No enrollment, data fixture, secret, sample, API, public listener, ready marker,
backup overwrite, release promotion, Git mutation, or database migration is allowed.
REMAINING GATE: replace zero-row-only operator with a separately reviewed,
role-limited persistent pilot lifecycle before ANY telemetry writes.
NO DATABASE STARTED BY PLAN | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO
PLAN
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ "$ROOT" == "$HOME/Projects/pulse-metrics" ]] || refuse 'Unexpected project root'
cd "$ROOT"
for bin in sudo pg_config git sha256sum cut bash node; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing required tool: $bin"
done
# Neutralize libpq overrides before invoking the reviewed PostgreSQL tools.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA PGCONNECT_TIMEOUT || true

OPERATOR='scripts/telemetry-persistent/local-development-postgres.sh'
BACKUP='scripts/telemetry-persistent/retained-local-cold-snapshot.sh'
RESTORE='scripts/telemetry-persistent/verify-retained-cold-restore.sh'
OFFLINE='scripts/telemetry-dev/inspect-incomplete-persistent-development.sh'
RELEASE='scripts/telemetry-persistent/release-candidates.mjs'
AGENT='src/agent/transport/local-dev-one-shot.ts'
HISTORY='scripts/telemetry-https/disposable-tenant-history.mjs'
HTTPS='scripts/telemetry-https/verify-sender-to-postgres.mjs'
PG_DATA='/var/lib/postgresql/pulse-metrics-dev-5u2/data'
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/postgres" ]] || refuse 'PostgreSQL tools missing'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'PostgreSQL 16 required'
[[ "$(git branch --show-current)" == 'feat/identity-organization-onboarding' ]] || refuse 'Unexpected Git branch'

check_pin() {
  local file="$1" expected="$2" observed
  [[ -f "$file" && ! -L "$file" ]] || refuse "Missing or linked reviewed source: $file"
  observed="$(sha256sum "$file" | cut -d' ' -f1)" || refuse "Cannot hash $file"
  [[ "$observed" == "$expected" ]] || refuse "Reviewed source mismatch: $file"
  printf 'PASS: pinned source %s\n' "$file"
}

# These are independently archived versions from the tested, full-file releases.
check_pin "$OPERATOR" '6286727b0ee8720a539f46aa2f87b87c84c013afd782099ba8bceae6ded34c3b'
check_pin "$BACKUP" '2e4c2d09044e85bc7b20ee3de451b549b958580ccf80c957fcf303bb5414d904'
check_pin "$RESTORE" '9e91b30027098cc7f7294f7143f63b873953204c9a4a9c89dd385b24d0567e4a'
check_pin "$OFFLINE" '7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'
check_pin "$RELEASE" '6aea75c795dc1b314a39452adc2c7aef64ff6340af92af7342dc1c58d4e76ce7'
check_pin "$AGENT" 'aed09c1e8b4c1ffa5f39364c6dcc7270448e5b4ea394a7e62dbcd6876498aa54'
check_pin "$HISTORY" '46860d6731ce22c4055239a6ea5df969063bf27fa424a88554edac93e5f10272'
check_pin "$HTTPS" '9a6f03571ea2e5597c60a672de1bb42dfbb9f51cd46d33cec1e3f54799486140'

echo '========== REVERIFY LOCKED DEVELOPMENT MIGRATION CANDIDATES =========='
node "$RELEASE" --verify || refuse 'Migration candidate verification failed'

echo '========== REVERIFY STOPPED ORIGINAL AND RETAINED SNAPSHOT =========='
bash "$OFFLINE" || refuse 'Stopped source and original database baseline failed'
bash "$BACKUP" --verify || refuse 'Retained snapshot integrity failed'

echo 'PASS: original cluster stopped; reviewed source and retained backup verified'
if [[ "$MODE" == --verify ]]; then
  echo '========== D15C-5U-2F2D PREPARATION VERIFY: PASS =========='
  echo 'READ-ONLY GATE ONLY | PERSISTENT TELEMETRY WRITES STILL NOT AUTHORIZED'
  echo 'NO DATABASE STARTED | NO MIGRATIONS | NO AGENTS | PUBLIC LAUNCH: NO_GO'
  exit 0
fi

# The existing operator REQUIRES zero operational rows. This is deliberately
# NOT a release or the operational audit that a real telemetry pilot needs.
echo '========== CONTROLLED ZERO-DATA DEVELOPMENT DATABASE AUDIT =========='
ATTEMPTED=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  set +e
  if (( ATTEMPTED )); then
    echo '========== MANDATORY TARGETED DATABASE SHUTDOWN =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; then
      bash "$OPERATOR" --stop || result=1
    else
      bash "$OFFLINE" || result=1
    fi
  fi
  echo '========== RECHECK BACKUP AFTER AUDIT =========='
  bash "$BACKUP" --verify || result=1
  if (( result != 0 )); then
    echo 'CRITICAL: audit or cleanup failed; inspect before doing anything else' >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ATTEMPTED=1
PULSE_APPROVE_5U2F_LOCAL_START=EXACT_SOCKET_ONLY bash "$OPERATOR" --start
bash "$OPERATOR" --audit
bash "$OPERATOR" --status
echo '========== D15C-5U-2F2D GUARDED LIVE AUDIT: PASS =========='
echo 'Only zero-row private database operation verified; no telemetry writes authorized.'
echo 'PUBLIC LAUNCH: NO_GO'
