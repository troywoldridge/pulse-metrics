#!/usr/bin/env bash
# D15C-5U-2F2L — separate disposable-only, test-key-only live SQL rehearsal.
# This NEVER alters the pinned 2F2K/4B source, 55433, or retained backups.
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"
DIR='scripts/telemetry-persistent'
ORIGINAL='scripts/test-telemetry-agent-quota-http-rehearsal.sh'
STAGE_K="$DIR/disposable-one-tenant-identity-stage.sh"
STAGE_L="$DIR/disposable-signed-live-binding-stage.sh"
BINDER="$DIR/disposable-signed-live-binding.mjs"
TESTS="$DIR/disposable-signed-live-binding.test.mjs"
REVIEWED_REF='78e6640'
ORIGINAL_SHA='79cdbcd0c3c10e5cf79716db96c7c5de61bfcde4b1344bf4f128cce0f6d64de8'
K_SHA='2132c01589e8471e3ef267e352f93ee3c3a5a46bb9759a91cf399c41b22d2efe'
L_SHA='4033256faa39b989bdc3547a15c75adfc8e5800aa3198912e64b2e9c5fb28a48'
BINDER_SHA='a65e6af6b7e03d8f62c802109857e62f4590d0ebdac224009e3671218b389bdc'
SQL_SHA='7e4550ea927fc52994b8d9137d3b6f348389a8f3fbb78c055be4aac78151710b'
J_SHA='e0b18ac52b9e38fee088b6d2eb2bd364d41d2d2dd7fe2254c7dfbee74a7bf390'
I_SHA='8146e464c67b425dff990a1a659d9f7e231b6ffd86e2c4f17bb3fad7bc4d1cd9'
K_RUN_SHA='a5bb813d26ddfb86685dfde4b936738917f3164613def62c94c3ba37e0f98b44'
K_FIXTURE_SHA='fed4cb4efee851a85f705dccdff58848a9ed76512201de3e9bc485b150f63a51'
J_READER_SHA='e16e24406db1a5a77836a060fbc837d86cac5c355443026feee6e9ec713ba0d9'
L_TEST_SHA='e9f2080f2b0eabf71cba4ac99129a416eb6cac5ddcb5220c20b9f6330c3f9f41'
I_TEST_SHA='b17304c0716800f2cd35085b6fe85fdef0b37258aa17792731c051ac93374fd6'
J_TEST_SHA='e8cc293cde148b2d78bf3bff5197b30c36ccaa73c0cd568b82b198cb8a6e6a1b'
K_TEST_SHA='fb44d026f09b2363ba1aefd3cd24e0905aac0c3901e7e60e027c1ae7161a1fda'
INV_SHA='332c10803dbf674c2ad31e6fe2c44ac9c143f296228b430853fe416a73ed1a41'

refuse() { printf 'REFUSE_D15C5U2F2L: %s\n' "$*" >&2; exit 1; }
plan() {
  cat <<'PLAN'
========== D15C-5U-2F2L SIGNED DISPOSABLE IDENTITY REHEARSAL PLAN ==========
--verify: pin existing original, 2F2K, 2F2J, 2F2I and new full sources;
          verify full temporary script composition; run offline tests only.
--exercise-disposable: separately approved SYNTHETIC-ONLY PostgreSQL 16 55432.
          Run full 2F2K live positive and negative identity tests, then stream
          another read-only SQL identity snapshot into an IN-MEMORY Ed25519
          signed-review test, reject test identity/signature/expiry tampering,
          require exact 2F2L PASS AND disposable destruction marker.
The test signature's fingerprint is self-pinned: it is NOT a real-world approval
or independent key ceremony. The 2F2I manifest's 55433 target is review-only.
No original scripts, PostgreSQL 55433, retained backup or customer rows altered.
NO REAL SIGNER | NO CUSTOMER ENROLLMENT | NO PERSISTENT WRITES | NO_GO
PLAN
}
[[ $# -eq 1 ]] || refuse 'exactly one CLI mode required'
case "$1" in
  --plan) plan; exit 0 ;;
  --verify|--exercise-disposable) MODE="$1" ;;
  *) refuse 'unsupported CLI mode' ;;
esac

[[ "$EUID" -ne 0 && "$(uname -s)" == Linux ]] || refuse 'ordinary Linux user required'
[[ "${NODE_ENV:-development}" == development ]] || refuse 'development only'
[[ -z "${NODE_OPTIONS:-}" && -z "${NODE_EXTRA_CA_CERTS:-}" ]] || refuse 'inherited Node options refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 ]] || refuse 'TLS bypass refused'
for name in DATABASE_URL MIGRATION_DATABASE_URL PGHOST PGHOSTADDR PGPORT PGUSER \
    PGDATABASE PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSWORD PGPASSFILE PGCLUSTER \
    PGSSLMODE PGSSLROOTCERT PGSSLKEY PGSSLCERT \
    PULSE_APPROVE_2F2K_DISPOSABLE PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE \
    PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY; do
  [[ -z "${!name:-}" ]] || refuse "unreviewed redirect/approval environment: $name"
done
for tool in git cmp sha256sum mktemp node python3 bash timeout pg_config sudo psql tee grep stat; do
  command -v "$tool" >/dev/null 2>&1 || refuse "missing prerequisite: $tool"
done
[[ "$(git branch --show-current)" == feat/identity-organization-onboarding ]] || refuse 'unreviewed project branch'
for file in "$ORIGINAL" "$STAGE_K" "$STAGE_L" "$BINDER" "$TESTS" \
    "$DIR/pilot-identity-evidence.sql" "$DIR/pilot-identity-evidence.mjs" \
    "$DIR/pilot-authorization-policy.mjs" \
    "$DIR/run-disposable-one-tenant-identity.sh" \
    "$DIR/disposable-one-tenant-identity-fixture.sql" \
    "$DIR/read-disposable-pilot-identity.sh" \
    "$DIR/pilot-inventory-policy.mjs" \
    "$DIR/pilot-authorization-policy.test.mjs" \
    "$DIR/pilot-identity-evidence.test.mjs" \
    "$DIR/disposable-one-tenant-identity.test.mjs"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -c %h "$file")" == 1 ]] ||
    refuse "required unchanged source missing/linked: $file"
done
printf '%s\n' \
  "$ORIGINAL_SHA  $ORIGINAL" \
  "$K_SHA  $STAGE_K" \
  "$L_SHA  $STAGE_L" \
  "$BINDER_SHA  $BINDER" \
  "$SQL_SHA  $DIR/pilot-identity-evidence.sql" \
  "$J_SHA  $DIR/pilot-identity-evidence.mjs" \
  "$I_SHA  $DIR/pilot-authorization-policy.mjs" \
  "$K_RUN_SHA  $DIR/run-disposable-one-tenant-identity.sh" \
  "$K_FIXTURE_SHA  $DIR/disposable-one-tenant-identity-fixture.sql" \
  "$J_READER_SHA  $DIR/read-disposable-pilot-identity.sh" \
  "$L_TEST_SHA  $TESTS" \
  "$I_TEST_SHA  $DIR/pilot-authorization-policy.test.mjs" \
  "$J_TEST_SHA  $DIR/pilot-identity-evidence.test.mjs" \
  "$K_TEST_SHA  $DIR/disposable-one-tenant-identity.test.mjs" \
  "$INV_SHA  $DIR/pilot-inventory-policy.mjs" |
  sha256sum -c - || refuse 'source fingerprints changed'
git cat-file -e "${REVIEWED_REF}:${ORIGINAL}" 2>/dev/null ||
  refuse 'reviewed original historical commit absent'
cmp -s "$ORIGINAL" <(git show "${REVIEWED_REF}:${ORIGINAL}") ||
  refuse 'original source no longer matches reviewed Git baseline'
bash -n "$ORIGINAL" && bash -n "$STAGE_K" && bash -n "$STAGE_L" || refuse 'shell parsing failed'
node --check "$BINDER" || refuse 'signed binding JavaScript parsing failed'

compose() {
  local output="$1"
  python3 - "$ORIGINAL" "$STAGE_K" "$STAGE_L" "$output" <<'PY'
from pathlib import Path
import hashlib, sys
old, k, l, target = map(Path, sys.argv[1:])
a, b, c = old.read_bytes(), k.read_bytes(), l.read_bytes()
required = [
 ('original',a,'79cdbcd0c3c10e5cf79716db96c7c5de61bfcde4b1344bf4f128cce0f6d64de8'),
 ('2F2K',b,'2132c01589e8471e3ef267e352f93ee3c3a5a46bb9759a91cf399c41b22d2efe'),
 ('2F2L',c,'4033256faa39b989bdc3547a15c75adfc8e5800aa3198912e64b2e9c5fb28a48'),
]
for label, source, sha in required:
    if hashlib.sha256(source).hexdigest() != sha:
        raise SystemExit(f'REFUSE_D15C5U2F2L: {label} source changed during composition')
anchor = b"echo '========== CREATE SYNTHETIC CUSTOMER AND AGENT FIXTURES =========='"
if a.count(anchor) != 1:
    raise SystemExit('REFUSE_D15C5U2F2L: unexpected source insertion point')
prefix = a.split(anchor)[0]
for marker in [b'trap cleanup EXIT', b'BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"',
               b'echo \'========== INSTALL PINNED AUTHENTICATED AGENT QUOTA ==========\'']:
    if marker not in prefix:
        raise SystemExit('REFUSE_D15C5U2F2L: reviewed cleanup/setup prefix missing')
if b'ONE-TENANT LIVE SQL REHEARSAL: PASS' not in b or b'LIVE SQL + TEST-ONLY SIGNATURE BINDING: PASS' not in c:
    raise SystemExit('REFUSE_D15C5U2F2L: expected stages missing')
compiled = prefix + b'\n' + b + b'\n' + c + b'\nexit 0\n'
if not compiled.startswith(b'#!/usr/bin/env bash\n'):
    raise SystemExit('REFUSE_D15C5U2F2L: generated script header invalid')
if target == Path('/dev/null'):
    print('PASS: pinned original cleanup + complete 2F2K + 2F2L source compose safely')
else:
    target.write_bytes(compiled)
PY
}
compose /dev/null || refuse 'full-script composition failed'
# Tests run without activation approval; they never start PostgreSQL.
if [[ "$MODE" == --verify ]]; then
  [[ -z "${PULSE_APPROVE_2F2L_DISPOSABLE:-}" ]] || refuse 'approval forbidden in verification mode'
fi
env -u PULSE_APPROVE_2F2L_DISPOSABLE \
  node --test "$TESTS" "$DIR/pilot-authorization-policy.test.mjs" \
    "$DIR/pilot-identity-evidence.test.mjs" \
    "$DIR/disposable-one-tenant-identity.test.mjs" ||
  refuse '2F2L + prior 2F2I/2F2J/2F2K offline tests failed'
if [[ "$MODE" == --verify ]]; then
  echo '========== D15C-5U-2F2L OFFLINE PREFLIGHT: PASS =========='
  echo 'NO POSTGRESQL START | NO REAL SIGNER | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO'
  exit 0
fi

[[ "${PULSE_APPROVE_2F2L_DISPOSABLE:-}" == RUN_SYNTHETIC_SIGNATURE_AND_DESTROY ]] ||
  refuse 'separate exact disposable-only approval required'
[[ "$(pg_config --version)" == PostgreSQL\ 16.* ]] || refuse 'reviewed PostgreSQL 16 required'
[[ -f .env && ! -L .env ]] || refuse 'reviewed nonproduction local .env required'
TMP=''
LOG=''
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$TMP" && "$TMP" =~ ^${ROOT}/scripts/\.pulse-d15c5u2f2l-[A-Za-z0-9]{8}[.]sh$ &&
      -f "$TMP" && ! -L "$TMP" && -O "$TMP" ]]; then
    rm -f -- "$TMP" || status=1
  fi
  if [[ -n "$LOG" && "$LOG" =~ ^/tmp/pulse-d15c5u2f2l-output-[A-Za-z0-9]{8}$ &&
      -f "$LOG" && ! -L "$LOG" && -O "$LOG" ]]; then
    rm -f -- "$LOG" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TMP="$(mktemp "$ROOT/scripts/.pulse-d15c5u2f2l-XXXXXXXX.sh")"
LOG="$(mktemp /tmp/pulse-d15c5u2f2l-output-XXXXXXXX)"
[[ "$TMP" =~ ^${ROOT}/scripts/\.pulse-d15c5u2f2l-[A-Za-z0-9]{8}[.]sh$ ]] || refuse 'unexpected generated script path'
[[ "$LOG" =~ ^/tmp/pulse-d15c5u2f2l-output-[A-Za-z0-9]{8}$ ]] || refuse 'unexpected output log path'
compose "$TMP" || refuse 'generated complete script refused'
bash -n "$TMP" || refuse 'generated complete script failed Bash syntax check'
echo '========== D15C-5U-2F2L START DISPOSABLE SIGNED-IDENTITY REHEARSAL =========='
# The original D15C-4B trap owns the disposable database stop and deletion.
# Both positive audit markers and the cleanup marker are mandatory for PASS.
timeout --signal=TERM --kill-after=120s 900s bash "$TMP" 2>&1 | tee "$LOG" ||
  refuse 'disposable PostgreSQL exercise or cleanup failed'
for marker in \
  '========== D15C-5U-2F2K ONE-TENANT LIVE SQL REHEARSAL: PASS ==========' \
  '========== D15C-5U-2F2L LIVE SQL + TEST-ONLY SIGNATURE BINDING: PASS ==========' \
  'PASS: disposable quota PostgreSQL cluster removed'; do
  grep -Fqx -- "$marker" "$LOG" || refuse "mandatory success/destruction marker missing"
done
echo '========== D15C-5U-2F2L SIGNED REHEARSAL + MANDATORY DESTRUCTION: PASS =========='
echo 'SYNTHETIC KEY ONLY | PROTECTED 55433 NOT TARGETED | PERSISTENT WRITES: NO | PUBLIC LAUNCH: NO_GO'
