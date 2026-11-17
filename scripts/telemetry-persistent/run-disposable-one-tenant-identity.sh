#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F2K: PINNED, SINGLE-USE, FULLY DISPOSABLE
# PostgreSQL 16 synthetic owner/agent identity audit. Never target 55433.
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"
DIR='scripts/telemetry-persistent'
ORIGINAL='scripts/test-telemetry-agent-quota-http-rehearsal.sh'
STAGE="$DIR/disposable-one-tenant-identity-stage.sh"
FIXTURE="$DIR/disposable-one-tenant-identity-fixture.sql"
AUDITOR="$DIR/read-disposable-pilot-identity.sh"
SQL="$DIR/pilot-identity-evidence.sql"
POLICY="$DIR/pilot-identity-evidence.mjs"
TESTS="$DIR/disposable-one-tenant-identity.test.mjs"
J_TESTS="$DIR/pilot-identity-evidence.test.mjs"
REVIEWED_REF='78e6640'
ORIGINAL_SHA='79cdbcd0c3c10e5cf79716db96c7c5de61bfcde4b1344bf4f128cce0f6d64de8'
STAGE_SHA='2132c01589e8471e3ef267e352f93ee3c3a5a46bb9759a91cf399c41b22d2efe'
FIXTURE_SHA='fed4cb4efee851a85f705dccdff58848a9ed76512201de3e9bc485b150f63a51'
AUDITOR_SHA='e16e24406db1a5a77836a060fbc837d86cac5c355443026feee6e9ec713ba0d9'
SQL_SHA='7e4550ea927fc52994b8d9137d3b6f348389a8f3fbb78c055be4aac78151710b'
POLICY_SHA='e0b18ac52b9e38fee088b6d2eb2bd364d41d2d2dd7fe2254c7dfbee74a7bf390'
TESTS_SHA='fb44d026f09b2363ba1aefd3cd24e0905aac0c3901e7e60e027c1ae7161a1fda'
J_TESTS_SHA='e8cc293cde148b2d78bf3bff5197b30c36ccaa73c0cd568b82b198cb8a6e6a1b'

refuse() { printf 'REFUSE_D15C5U2F2K: %s\n' "$*" >&2; exit 1; }
plan() {
  cat <<'PLAN'
========== D15C-5U-2F2K ONE-TENANT DISPOSABLE REHEARSAL PLAN ==========
--verify: check pinned original D15C-4B source/commit, 2F2J identity audit,
          complete new stage/fixture, and run offline fail-closed tests.
--exercise-disposable: requires separate exact 2F2K synthetic-only approval.
          Generate a COMPLETE temporary copy of reviewed D15C-4B source up
          through authenticated agent quota migration; install reviewed 4E
          update inside new /tmp/pulse-replay-XXXXXXXXXX PostgreSQL 16 at 55432,
          create one synthetic owner/org/agent/credential with NO telemetry,
          execute actual 2F2J read-only SQL and live negative denial probes,
          then mandatory stop and REMOVE the disposable cluster.
The original 2-tenant test and protected 55433 source/backup are untouched.
NO SIGNING KEY | NO REAL WORKOS USER | NO RETAINED TELEMETRY | PUBLIC LAUNCH: NO_GO
PLAN
}
[[ $# -eq 1 ]] || refuse 'exactly one mode is required'
case "$1" in
  --plan) plan; exit 0 ;;
  --verify|--exercise-disposable) MODE="$1" ;;
  *) refuse 'mode must be --plan, --verify or --exercise-disposable' ;;
esac

[[ "$EUID" -ne 0 ]] || refuse 'root execution refused'
[[ "$(uname -s)" == Linux ]] || refuse 'Linux is required'
[[ "${NODE_ENV:-development}" == development ]] || refuse 'development mode required'
[[ -z "${NODE_OPTIONS:-}" && -z "${NODE_EXTRA_CA_CERTS:-}" ]] ||
  refuse 'inherited Node options are refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 ]] || refuse 'TLS bypass is refused'
for name in DATABASE_URL MIGRATION_DATABASE_URL PGHOST PGHOSTADDR PGPORT PGUSER \
    PGDATABASE PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSWORD PGPASSFILE PGCLUSTER \
    PGSSLMODE PGSSLROOTCERT PGSSLKEY PGSSLCERT \
    PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE \
    PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY; do
  [[ -z "${!name:-}" ]] || refuse "unexpected redirect or approval variable: $name"
done
for tool in bash node python3 sha256sum git cmp mktemp stat timeout tee grep pg_config sudo psql; do
  command -v "$tool" >/dev/null 2>&1 || refuse "required command missing: $tool"
done
[[ "$(git branch --show-current)" == feat/identity-organization-onboarding ]] ||
  refuse 'unexpected project branch'
for file in "$ORIGINAL" "$STAGE" "$FIXTURE" "$AUDITOR" "$SQL" "$POLICY" "$TESTS" "$J_TESTS"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -c %h "$file")" == 1 ]] ||
    refuse "required source is absent, symlinked or hard-linked: $file"
done
printf '%s\n' \
  "$ORIGINAL_SHA  $ORIGINAL" \
  "$STAGE_SHA  $STAGE" \
  "$FIXTURE_SHA  $FIXTURE" \
  "$AUDITOR_SHA  $AUDITOR" \
  "$SQL_SHA  $SQL" \
  "$POLICY_SHA  $POLICY" \
  "$TESTS_SHA  $TESTS" \
  "$J_TESTS_SHA  $J_TESTS" | sha256sum -c - || refuse 'source fingerprint mismatch'

git cat-file -e "${REVIEWED_REF}:${ORIGINAL}" 2>/dev/null ||
  refuse 'reviewed baseline commit not available'
cmp -s "$ORIGINAL" <(git show "${REVIEWED_REF}:${ORIGINAL}") ||
  refuse 'current original rehearsal differs from reviewed Git commit'

bash -n "$ORIGINAL" || refuse 'original shell source parsing failed'
bash -n "$STAGE" || refuse 'embedded stage shell parsing failed'

# Validate the exact complete-file composition without executing anything.
# The original reviewed cleanup() and EXIT/TERM traps are retained intact.
verify_composition() {
  python3 - "$ORIGINAL" "$STAGE" /dev/null <<'PY'
import hashlib
from pathlib import Path
import sys
original, stage = (Path(sys.argv[1]), Path(sys.argv[2]))
a = original.read_bytes()
b = stage.read_bytes()
assert hashlib.sha256(a).hexdigest() == '79cdbcd0c3c10e5cf79716db96c7c5de61bfcde4b1344bf4f128cce0f6d64de8'
assert hashlib.sha256(b).hexdigest() == '2132c01589e8471e3ef267e352f93ee3c3a5a46bb9759a91cf399c41b22d2efe'
anchor = b"echo '========== CREATE SYNTHETIC CUSTOMER AND AGENT FIXTURES =========='"
assert a.count(anchor) == 1
assert b"trap cleanup EXIT" in a.split(anchor)[0]
assert b"BASE=\"$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)\"" in a.split(anchor)[0]
assert b"echo '========== INSTALL PINNED AUTHENTICATED AGENT QUOTA =========='" in a.split(anchor)[0]
assert b"echo '========== D15C-4B ATOMIC MIGRATION ROLLBACK =========='" in a.split(anchor)[0]
assert b"echo '========== CREATE SYNTHETIC CUSTOMER AND AGENT FIXTURES =========='" not in a.split(anchor)[0]
# Test output is a full temporary replacement of original source, not patching
# the original source and not altering any protected development PostgreSQL.
compiled = a.split(anchor)[0] + b'\n' + b + b'\nexit 0\n'
assert compiled.startswith(b'#!/usr/bin/env bash\n')
assert compiled.endswith(b'\nexit 0\n')
print('PASS: exact reviewed disposable prefix and complete one-tenant stage compose safely')
PY
}
verify_composition || refuse 'complete-file composition validation failed'
env -u PULSE_APPROVE_2F2K_DISPOSABLE \
  node --test "$TESTS" "$J_TESTS" || refuse '2F2K offline tests failed'
if [[ "$MODE" == --verify ]]; then
  [[ -z "${PULSE_APPROVE_2F2K_DISPOSABLE:-}" ]] ||
    refuse 'live approval is forbidden during verify-only'
  echo '========== D15C-5U-2F2K DISPOSABLE PREFLIGHT: PASS =========='
  echo 'NO POSTGRESQL START | NO DATA WRITES | PUBLIC LAUNCH: NO_GO'
  exit 0
fi

[[ "${PULSE_APPROVE_2F2K_DISPOSABLE:-}" == RUN_SYNTHETIC_ONE_TENANT_AND_DESTROY ]] ||
  refuse 'independent exact synthetic-only disposable approval required'
[[ "$(pg_config --version)" == PostgreSQL\ 16.* ]] ||
  refuse 'PostgreSQL 16 required; no cluster started'
[[ -f .env && ! -L .env ]] || refuse 'reviewed local development .env missing'

TMP=''
LOG=''
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$TMP" && "$TMP" =~ ^${ROOT}/scripts/\.pulse-d15c5u2f2k-[A-Za-z0-9]{8}[.]sh$ &&
        -f "$TMP" && ! -L "$TMP" && -O "$TMP" ]]; then
    rm -f -- "$TMP" || code=1
  fi
  if [[ -n "$LOG" && "$LOG" =~ ^/tmp/pulse-d15c5u2f2k-output-[A-Za-z0-9]{8}$ &&
        -f "$LOG" && ! -L "$LOG" && -O "$LOG" ]]; then
    rm -f -- "$LOG" || code=1
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TMP="$(mktemp "$ROOT/scripts/.pulse-d15c5u2f2k-XXXXXXXX.sh")"
LOG="$(mktemp /tmp/pulse-d15c5u2f2k-output-XXXXXXXX)"
[[ "$TMP" =~ ^${ROOT}/scripts/\.pulse-d15c5u2f2k-[A-Za-z0-9]{8}[.]sh$ ]] ||
  refuse 'unrecognized generated rehearsal copy'
[[ "$LOG" =~ ^/tmp/pulse-d15c5u2f2k-output-[A-Za-z0-9]{8}$ ]] ||
  refuse 'unrecognized test output file'

python3 - "$ORIGINAL" "$STAGE" "$TMP" <<'PY'
from pathlib import Path
import hashlib, sys
original, stage, generated = (Path(x) for x in sys.argv[1:4])
a, b = original.read_bytes(), stage.read_bytes()
if (hashlib.sha256(a).hexdigest() != '79cdbcd0c3c10e5cf79716db96c7c5de61bfcde4b1344bf4f128cce0f6d64de8' or
    hashlib.sha256(b).hexdigest() != '2132c01589e8471e3ef267e352f93ee3c3a5a46bb9759a91cf399c41b22d2efe'):
    raise SystemExit('REFUSE_D15C5U2F2K: source changed during generation')
anchor = b"echo '========== CREATE SYNTHETIC CUSTOMER AND AGENT FIXTURES =========='"
if a.count(anchor) != 1 or b'trap cleanup EXIT' not in a.split(anchor)[0]:
    raise SystemExit('REFUSE_D15C5U2F2K: pinned lifecycle split changed')
compiled = a.split(anchor)[0] + b'\n' + b + b'\nexit 0\n'
generated.write_bytes(compiled)
print('PASS: generated isolated complete-file rehearsal; original source unchanged')
PY
bash -n "$TMP" || refuse 'temporary complete-file script did not parse'

echo '========== START D15C-5U-2F2K FULLY DISPOSABLE ONE-TENANT REHEARSAL =========='
# Original D15C-4B trap owns deletion of the disposable cluster. The outer
# timeout allows TERM/EXIT cleanup time. Both PASS markers are mandatory.
timeout --signal=TERM --kill-after=120s 900s bash "$TMP" 2>&1 | tee "$LOG" ||
  refuse 'disposable rehearsal or mandatory cleanup failed'
grep -Fqx '========== D15C-5U-2F2K ONE-TENANT LIVE SQL REHEARSAL: PASS ==========' "$LOG" ||
  refuse 'real 2F2J PostgreSQL identity evidence was not accepted'
grep -Fqx 'PASS: disposable quota PostgreSQL cluster removed' "$LOG" ||
  refuse 'original reviewed lifecycle did not confirm disposable destruction'
echo '========== D15C-5U-2F2K REHEARSAL + MANDATORY DESTRUCTION: PASS =========='
echo 'PROTECTED 55433 NEVER TARGETED | NO SIGNER OR ENROLLMENT | PUBLIC LAUNCH: NO_GO'
