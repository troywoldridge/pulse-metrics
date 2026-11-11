#!/usr/bin/env bash
# Development only. Uses persistent DB counters with a random HMAC key.
# No real WorkOS profile is fetched and no invitation/membership is created.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: Local .env is required' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo is required' >&2; exit 1; }
node --env-file=.env --input-type=module <<'NODE'
const raw=process.env.DATABASE_URL;
if (!raw) throw Error('No local DATABASE_URL');
const u=new URL(raw);
if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost', '127.0.0.1', '::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1))!=='pulse_metrics' ||
    decodeURIComponent(u.username)!=='pulse_metrics_app' ||
    process.env.NODE_ENV==='production') throw Error('Unsafe database target: refusing rate-limit test');
console.log('PASS: restricted role on local pulse_metrics database');
NODE
export PULSE_RATE_TEST_KEY
PULSE_RATE_TEST_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
export PULSE_RATE_TEST_ISSUER="user_rate_http_${SUFFIX}_issuer"
export PULSE_RATE_TEST_RECIPIENT="user_rate_http_${SUFFIX}_recipient"
mapfile -t DIGESTS < <(node <<'NODE'
const {createHmac}=require('node:crypto');
for(const [action,kind,key] of [
  ['issue','network','127.0.0.1'],
  ['issue','actor',process.env.PULSE_RATE_TEST_ISSUER],
  ['accept','network','127.0.0.1'],
  ['accept','actor',process.env.PULSE_RATE_TEST_RECIPIENT],
]) console.log(createHmac('sha256',Buffer.from(process.env.PULSE_RATE_TEST_KEY,'base64url'))
   .update(`pulse-invitation-v1\0${action}\0${kind}\0${key}`,'utf8').digest('hex'));
NODE
)
[[ "${#DIGESTS[@]}" -eq 4 ]] || { echo 'ERROR: fixture digests unavailable' >&2; exit 1; }
cleanup() {
  local initial="$?"
  trap - EXIT
  set +e
  echo '========== REMOVE SYNTHETIC RATE-LIMIT COUNTERS =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v d1="${DIGESTS[0]}" -v d2="${DIGESTS[1]}" \
    -v d3="${DIGESTS[2]}" -v d4="${DIGESTS[3]}" <<'SQL'
DELETE FROM public.invitation_rate_limits
WHERE bucket_digest IN (:'d1',:'d2',:'d3',:'d4');
SQL
  local removed="$?"
  if [[ "$removed" -ne 0 ]]; then
    echo 'ERROR: synthetic counter cleanup failed' >&2
    exit 1
  fi
  echo 'PASS: synthetic rate-limit counters removed'
  exit "$initial"
}
trap cleanup EXIT
echo '========== REAL EXPRESS + RESTRICTED POSTGRESQL LIMITS =========='
node --env-file=.env --import tsx --test tests/integration/invitation-rate-limit-http-db.integration.test.ts

echo '========== VERIFY SHARED POSTGRESQL COUNTER STATE =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v d1="${DIGESTS[0]}" -v d2="${DIGESTS[1]}" \
    -v d3="${DIGESTS[2]}" -v d4="${DIGESTS[3]}" <<'SQL'
SELECT set_config('test.rate_d1',:'d1',false),
       set_config('test.rate_d2',:'d2',false),
       set_config('test.rate_d3',:'d3',false),
       set_config('test.rate_d4',:'d4',false);
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits
    WHERE action='issue' AND bucket_kind='network'
      AND bucket_digest=current_setting('test.rate_d1') AND attempts=61)
  OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits
    WHERE action='issue' AND bucket_kind='actor'
      AND bucket_digest=current_setting('test.rate_d2') AND attempts=11)
  OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits
    WHERE action='accept' AND bucket_kind='network'
      AND bucket_digest=current_setting('test.rate_d3') AND attempts=21)
  OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits
    WHERE action='accept' AND bucket_kind='actor'
      AND bucket_digest=current_setting('test.rate_d4') AND attempts=21) THEN
    RAISE EXCEPTION 'Unexpected rate-limit bucket counts';
  END IF;
END;
$verify$;
SQL
echo 'PASS: real Express rate-limit guard order and DB counter state verified'
