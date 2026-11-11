#!/usr/bin/env bash
# DEVELOPMENT ONLY: synthetic WorkOS, actual restricted PostgreSQL counters.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: Local .env required' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo required for fixture audit and cleanup' >&2; exit 1; }
node --env-file=.env --input-type=module <<'NODE'
const raw=process.env.DATABASE_URL;
if (!raw) throw Error('Missing DATABASE_URL');
const value=new URL(raw);
if (!['postgres:','postgresql:'].includes(value.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(value.hostname.toLowerCase()) ||
    decodeURIComponent(value.pathname.slice(1))!=='pulse_metrics' ||
    decodeURIComponent(value.username)!=='pulse_metrics_app' ||
    process.env.NODE_ENV==='production') throw Error('Unsafe test database target');
console.log('PASS: local pulse_metrics and restricted app role');
NODE
export PULSE_PROXY_TEST_KEY
PULSE_PROXY_TEST_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
export PULSE_PROXY_TEST_SUBJECT="user_proxy_http_${SUFFIX}"
mapfile -t DIGESTS < <(node <<'NODE'
const {createHmac}=require('node:crypto');
for(const [action,kind,id] of [
  ['issue','network','198.51.100.11'],
  ['issue','actor',process.env.PULSE_PROXY_TEST_SUBJECT],
  ['issue','network','198.51.100.22'],
  ['issue','network','2001:db8::1'],
]) {
  console.log(createHmac('sha256',Buffer.from(process.env.PULSE_PROXY_TEST_KEY,'base64url'))
    .update(`pulse-invitation-v1\0${action}\0${kind}\0${id}`,'utf8').digest('hex'));
}
NODE
)
[[ "${#DIGESTS[@]}" -eq 4 ]] || { echo 'ERROR: Incomplete test digests' >&2; exit 1; }
cleanup(){
  local previous=$?
  trap - EXIT
  set +e
  echo '========== CLEAN SYNTHETIC PROXY RATE-LIMIT COUNTERS =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v d1="${DIGESTS[0]}" -v d2="${DIGESTS[1]}" \
    -v d3="${DIGESTS[2]}" -v d4="${DIGESTS[3]}" <<'SQL'
DELETE FROM public.invitation_rate_limits
WHERE bucket_digest IN (:'d1',:'d2',:'d3',:'d4');
SQL
  local result=$?
  if [[ "$result" -ne 0 ]]; then
    echo 'ERROR: synthetic fixture cleanup failed' >&2
    exit 1
  fi
  echo 'PASS: synthetic counters removed'
  exit "$previous"
}
trap cleanup EXIT

echo '========== REAL HTTP + POSTGRESQL TRUSTED PROXY SECURITY =========='
node --env-file=.env --import tsx --test tests/integration/invitation-trusted-proxy-http-db.integration.test.ts

echo '========== VERIFY REAL COUNTER PARTITIONING =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v d1="${DIGESTS[0]}" -v d2="${DIGESTS[1]}" \
  -v d3="${DIGESTS[2]}" -v d4="${DIGESTS[3]}" <<'SQL'
SELECT set_config('test.proxy1',:'d1',false),
       set_config('test.proxy2',:'d2',false),
       set_config('test.proxy3',:'d3',false),
       set_config('test.proxy4',:'d4',false);
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits
      WHERE action='issue' AND bucket_kind='network'
      AND bucket_digest=current_setting('test.proxy1') AND attempts=61)
     OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits
      WHERE action='issue' AND bucket_kind='actor'
      AND bucket_digest=current_setting('test.proxy2') AND attempts=11)
     OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits
      WHERE action='issue' AND bucket_kind='network'
      AND bucket_digest=current_setting('test.proxy3') AND attempts=1)
     OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits
      WHERE action='issue' AND bucket_kind='network'
      AND bucket_digest=current_setting('test.proxy4') AND attempts=2) THEN
    RAISE EXCEPTION 'Trusted proxy rate-limit bucket count mismatch';
  END IF;
END;
$verify$;
SQL
echo 'PASS: trusted client address partitioning and rate-limit state verified'
