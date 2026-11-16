#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F2G — guarded persistent pilot CANDIDATE.
# An intentionally conservative adapter. This stage tests policy and the
# pre-write EMPTY baseline only. It NEVER authorizes persistent telemetry,
# enrollment, fixture installation, migrations, HTTP routes or production.
# Do not replace the proven zero-row recovery operator with this script.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2F2G: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || refuse 'Use exactly --plan | --verify | --exercise-empty'
case "$1" in
  --plan|--verify|--exercise-empty) MODE="$1" ;;
  *) refuse 'Unknown mode; nonzero start and write modes are NOT enabled' ;;
esac
[[ "$(uname -s)" == Linux ]] || refuse 'Linux required'
[[ "${NODE_ENV:-development}" == development ]] || refuse 'Development only; production forbidden'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited DB URL forbidden'
[[ -z "${NODE_OPTIONS:-}" && -z "${NODE_EXTRA_CA_CERTS:-}" ]] || refuse 'Inherited Node or TLS override forbidden'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-1}" != 0 ]] || refuse 'TLS bypass forbidden'
for flag in PULSE_ENABLE_PUBLIC_INGRESS PULSE_ENABLE_TELEMETRY_SERVICE PULSE_D15C5U_LOCAL_ONLY; do
  [[ -z "${!flag:-}" ]] || refuse "Service or sender flag not allowed: $flag"
done
for flag in PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA PGCONNECT_TIMEOUT; do
  [[ -z "${!flag:-}" ]] || refuse "Inherited libpq target override forbidden: $flag"
done
if [[ "$MODE" == --exercise-empty ]]; then
  [[ "${PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE:-}" == 'START_AUDIT_STOP_NO_WRITES' ]] ||
    refuse 'Independent exact START_AUDIT_STOP_NO_WRITES approval required'
fi

if [[ "$MODE" == --plan ]]; then
  cat <<'PLAN'
========== D15C-5U-2F2G GUARDED PERSISTENT PILOT PLAN ==========
--verify: verify reviewed operator/policy sources, stopped quarantined database,
          release candidates and the retained, restore-tested same-host backup.
--exercise-empty: independently approved exact 55433 Unix-socket zero-row
          START -> security AUDIT -> STOP using existing reviewed operator.
          Stop is mandatory on failure; backup and quarantine reverified.
The new policy module can reject unauthorized bounded ONE-agent inventory, but
NO LIVE ADAPTER for nonzero state and NO approved policy manifest are installed.
The one-agent policy tests are OFFLINE CONTRACT TESTS, not PostgreSQL proof.
No production, ingress, agent enrollment, telemetry write, migration, ready
marker, backup overwrite, or nonzero database startup is authorized here.
NO POSTGRESQL STARTED BY PLAN | PERSISTENT TELEMETRY WRITES: NOT APPROVED
PUBLIC LAUNCH: NO_GO
PLAN
  exit 0
fi

[[ "$(id -u)" -ne 0 ]] || refuse 'Non-root operator required'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ "$ROOT" == "$HOME/Projects/pulse-metrics" ]] || refuse 'Unexpected project location'
cd "$ROOT"
for bin in bash sudo pg_config sha256sum cut node git; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing required executable: $bin"
done
[[ "$(git branch --show-current)" == 'feat/identity-organization-onboarding' ]] ||
  refuse 'Git branch does not match the reviewed project branch'

F2D='scripts/telemetry-persistent/prepare-local-persistent-pilot.sh'
OPERATOR='scripts/telemetry-persistent/local-development-postgres.sh'
BACKUP='scripts/telemetry-persistent/retained-local-cold-snapshot.sh'
OFFLINE='scripts/telemetry-dev/inspect-incomplete-persistent-development.sh'
F2F='scripts/telemetry-persistent/nonzero-pilot-ledger.sql'
POLICY='scripts/telemetry-persistent/pilot-inventory-policy.mjs'
TEST='scripts/telemetry-persistent/pilot-inventory-policy.test.mjs'
PG_DATA='/var/lib/postgresql/pulse-metrics-dev-5u2/data'
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/postgres" ]] ||
  refuse 'Unexpected PostgreSQL installation'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] ||
  refuse 'PostgreSQL 16 required'

pin() {
  local path="$1" expected="$2" observed
  [[ -f "$path" && ! -L "$path" ]] || refuse "Missing or linked source: $path"
  observed="$(sha256sum "$path" | cut -d ' ' -f1)" || refuse "Unable to hash $path"
  [[ "$observed" == "$expected" ]] || refuse "Source drift detected: $path"
  printf 'PASS: pinned %s\n' "$path"
}
pin "$F2D" '482461d6dbf18ccfc2370ae32faf335c8b840b5d8efcbf5c6473dd38def446bd'
pin "$OPERATOR" '6286727b0ee8720a539f46aa2f87b87c84c013afd782099ba8bceae6ded34c3b'
pin "$BACKUP" '2e4c2d09044e85bc7b20ee3de451b549b958580ccf80c957fcf303bb5414d904'
pin "$OFFLINE" '7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'
pin "$F2F" 'c7861e43faae020a5e8d4de0f83509a277c1960694369a7db90631f7d5a9f862'
pin "$POLICY" '332c10803dbf674c2ad31e6fe2c44ac9c143f296228b430853fe416a73ed1a41'
[[ -f "$TEST" && ! -L "$TEST" ]] || refuse 'Policy tests missing or linked'

# The future nonzero adapter MUST provide independently queried, read-only
# PostgreSQL facts AND a separately approved roster. It does not exist yet.
node --check "$POLICY"
# The caller's exact live-exercise approval is exclusively for this parent
# process. Regression tests must not inherit it: their negative probes launch
# this operator and must observe refusal BEFORE any sudo or DB access.
# This is defense-in-depth; the test subprocesses also scrub it explicitly.
env -u PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE \
  node --test "$TEST" || refuse 'Policy regression tests failed'

echo '========== RECHECK FROZEN PRE-WRITE DEVELOPMENT FOUNDATION =========='
bash "$F2D" --verify || refuse 'Persistent preflight failed'
echo '========== D15C-5U-2F2G GUARDED VERIFY: PASS =========='
echo 'No nonzero activation, no identity admission, no persistent data writes.'
if [[ "$MODE" == --verify ]]; then
  echo 'NO DATABASE STARTED | PUBLIC LAUNCH: NO_GO'
  exit 0
fi

START_ATTEMPTED=0
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if (( START_ATTEMPTED )); then
    echo '========== 2F2G MANDATORY POST-AUDIT SHUTDOWN VERIFICATION =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; then
      bash "$OPERATOR" --stop || code=1
    fi
    bash "$OFFLINE" || code=1
    bash "$BACKUP" --verify || code=1
  fi
  (( code == 0 )) || echo 'CRITICAL: audit or shutdown verification failed — inspect before continuing' >&2
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Reuse the already reviewed zero-row lifecycle rather than reimplementing
# database start and stop. Its own trap shuts down on ALL failures.
START_ATTEMPTED=1
PULSE_APPROVE_5U2F2D_READ_ONLY_AUDIT=START_AUDIT_STOP_ZERO_ROWS \
  bash "$F2D" --audit

echo '========== D15C-5U-2F2G EMPTY-LIFECYCLE EXERCISE: PASS =========='
echo 'STOPPED SOURCE + RETAINED BACKUP RECHECK REQUIRED BY EXIT TRAP'
echo 'PERSISTENT TELEMETRY WRITES: NOT APPROVED | PUBLIC LAUNCH: NO_GO'
