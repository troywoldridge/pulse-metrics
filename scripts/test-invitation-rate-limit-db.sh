#!/usr/bin/env bash
# LOCAL TEST ONLY: shared invitation rate-limit SQL through restricted runtime role.
# No real user/organization/WorkOS data is used or modified.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: local .env required' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo required' >&2; exit 1; }

node --env-file=.env --input-type=module <<'NODE'
const raw=process.env.DATABASE_URL;
if (!raw) throw Error('Missing DATABASE_URL');
const u=new URL(raw);
if (!['postgres:','postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1))!=='pulse_metrics' ||
    decodeURIComponent(u.username)!=='pulse_metrics_app' ||
    process.env.NODE_ENV==='production') {
  throw Error('Refusing fixture test against nonlocal / production / non-runtime DB');
}
console.log('PASS: local pulse_metrics database with restricted runtime role');
NODE

export PULSE_LIMIT_FIXTURE="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
mapfile -t DIGESTS < <(node --input-type=module <<'NODE'
import {createHash} from 'node:crypto';
for (const name of ['actor-issue','network-issue','actor-accept',
  'network-accept','concurrent','reset','separate']) {
  console.log(createHash('sha256')
    .update(`pulse-rate-limit-test-v1:${process.env.PULSE_LIMIT_FIXTURE}:${name}`)
    .digest('hex'));
}
NODE
)
[[ "${#DIGESTS[@]}" -eq 7 ]] || { echo 'ERROR: fixture digest setup failed' >&2; exit 1; }
for value in "${DIGESTS[@]}"; do
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo 'ERROR: invalid synthetic digest' >&2; exit 1; }
done

cleanup() {
  local original=$?
  trap - EXIT
  set +e
  echo '========== REMOVE SYNTHETIC RATE-LIMIT COUNTERS =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v a="${DIGESTS[0]}" -v b="${DIGESTS[1]}" -v c="${DIGESTS[2]}" \
    -v d="${DIGESTS[3]}" -v e="${DIGESTS[4]}" -v f="${DIGESTS[5]}" \
    -v g="${DIGESTS[6]}" <<'SQL'
DELETE FROM public.invitation_rate_limits
WHERE bucket_digest IN (:'a',:'b',:'c',:'d',:'e',:'f',:'g');
SQL
  local cleanup_exit=$?
  if [[ "$cleanup_exit" -ne 0 ]]; then
    echo 'ERROR: rate-limit fixture cleanup failed, inspect local database' >&2
    exit 1
  fi
  echo 'PASS: local synthetic counters removed'
  exit "$original"
}
trap cleanup EXIT

echo '========== RATE-LIMIT SECURITY GRANTS AND OWNERSHIP =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics <<'SQL'
DO $audit$
DECLARE r record;
        f record;
        public_exec boolean;
BEGIN
  SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
    rolbypassrls,rolinherit INTO r FROM pg_roles
    WHERE rolname='pulse_metrics_rate_limit_executor';
  IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb
    OR r.rolcreaterole OR r.rolreplication OR NOT r.rolbypassrls OR r.rolinherit THEN
    RAISE EXCEPTION 'Rate-limit executor role is not isolated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE
    roleid='pulse_metrics_rate_limit_executor'::regrole OR
    member='pulse_metrics_rate_limit_executor'::regrole) THEN
    RAISE EXCEPTION 'Rate-limit executor role membership is forbidden';
  END IF;
  SELECT c.relrowsecurity,c.relforcerowsecurity,c.relowner INTO r
  FROM pg_class c WHERE c.oid='public.invitation_rate_limits'::regclass;
  IF NOT FOUND OR NOT r.relrowsecurity OR NOT r.relforcerowsecurity OR
     r.relowner<>'pulse_metrics_migrator'::regrole THEN
    RAISE EXCEPTION 'Rate-limit table ownership or FORCE RLS is unsafe';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE
    schemaname='public' AND tablename='invitation_rate_limits') THEN
    RAISE EXCEPTION 'Rate-limit table must have no RLS policies';
  END IF;
  SELECT prosecdef,proowner,proconfig INTO f FROM pg_proc WHERE oid=
    'public.consume_invitation_rate_limit(text,text,text)'::regprocedure;
  -- Check ownership and security mode independently of the spelling of
  -- PostgreSQL's normalized GUC output. PostgreSQL stores the function GUC
  -- as 'search_path=pg_catalog, pg_temp' (with a space after the comma),
  -- even when CREATE FUNCTION specified 'pg_catalog,pg_temp'.
  IF NOT FOUND OR NOT f.prosecdef OR
     f.proowner <> 'pulse_metrics_rate_limit_executor'::regrole THEN
    RAISE EXCEPTION 'Rate-limit function owner or SECURITY DEFINER is unsafe';
  END IF;
  -- Require exactly one function-level GUC, exactly the trusted two schemas,
  -- and the same ordering. Ignore whitespace only, not schema differences.
  IF f.proconfig IS NULL OR cardinality(f.proconfig) <> 1 OR
     regexp_replace(f.proconfig[1], '[[:space:]]+', '', 'g') <>
       'search_path=pg_catalog,pg_temp' THEN
    RAISE EXCEPTION 'Rate-limit function search_path is unsafe';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_proc p,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid='public.consume_invitation_rate_limit(text,text,text)'::regprocedure
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE') INTO public_exec;
  IF public_exec THEN RAISE EXCEPTION 'PUBLIC EXECUTE is forbidden'; END IF;
  IF NOT has_function_privilege('pulse_metrics_app',
    'public.consume_invitation_rate_limit(text,text,text)','EXECUTE') OR
    has_table_privilege('pulse_metrics_app','public.invitation_rate_limits','SELECT') OR
    has_table_privilege('pulse_metrics_app','public.invitation_rate_limits','INSERT') OR
    has_table_privilege('pulse_metrics_app','public.invitation_rate_limits','UPDATE') OR
    has_table_privilege('pulse_metrics_app','public.invitation_rate_limits','DELETE') OR
    has_table_privilege('pulse_metrics_rate_limit_executor',
      'public.organization_memberships','INSERT') OR
    has_table_privilege('pulse_metrics_rate_limit_executor',
      'public.organization_invitations','SELECT') THEN
    RAISE EXCEPTION 'Unsafe rate-limit grants';
  END IF;
END;
$audit$;
SQL

echo '========== REAL RESTRICTED-ROLE, MULTI-CONNECTION TESTS =========='
node --env-file=.env --import tsx --test \
  tests/integration/invitation-rate-limit.integration.test.ts

echo '========== VERIFY ACTUAL COUNTERS AND WINDOW =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v a="${DIGESTS[0]}" -v b="${DIGESTS[1]}" -v c="${DIGESTS[2]}" \
  -v d="${DIGESTS[3]}" -v e="${DIGESTS[4]}" -v f="${DIGESTS[5]}" \
  -v g="${DIGESTS[6]}" <<'SQL'
SELECT set_config('test.rate_a',:'a',false),set_config('test.rate_b',:'b',false),
  set_config('test.rate_c',:'c',false),set_config('test.rate_d',:'d',false),
  set_config('test.rate_e',:'e',false),set_config('test.rate_f',:'f',false),
  set_config('test.rate_g',:'g',false);
DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits WHERE
    action='issue' AND bucket_kind='actor' AND
    bucket_digest=current_setting('test.rate_a') AND attempts=13)
  OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits WHERE
    action='issue' AND bucket_kind='network' AND
    bucket_digest=current_setting('test.rate_b') AND attempts=61)
  OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits WHERE
    action='accept' AND bucket_kind='actor' AND
    bucket_digest=current_setting('test.rate_c') AND attempts=21)
  OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits WHERE
    action='accept' AND bucket_kind='network' AND
    bucket_digest=current_setting('test.rate_d') AND attempts=121)
  OR NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits WHERE
    action='issue' AND bucket_kind='actor' AND
    bucket_digest=current_setting('test.rate_e') AND attempts=25) THEN
    RAISE EXCEPTION 'Missing or incorrect counters after concurrent/limit tests';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invitation_rate_limits WHERE
    bucket_digest IN (current_setting('test.rate_a'),current_setting('test.rate_b'),
      current_setting('test.rate_c'),current_setting('test.rate_d'),
      current_setting('test.rate_e'),current_setting('test.rate_f'),
      current_setting('test.rate_g'))
    AND window_end<=clock_timestamp()) THEN
    RAISE EXCEPTION 'Unexpected expired test counter';
  END IF;
END;
$verify$;
SQL

echo '========== SIMULATE WINDOW EXPIRATION (ADMINISTRATIVE TEST ONLY) =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v reset="${DIGESTS[5]}" <<'SQL'
UPDATE public.invitation_rate_limits
SET window_end=clock_timestamp()-interval '1 second'
WHERE action='issue' AND bucket_kind='actor' AND bucket_digest=:'reset';
SQL
node --env-file=.env --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import pg from 'pg';
const digest=createHash('sha256')
  .update(`pulse-rate-limit-test-v1:${process.env.PULSE_LIMIT_FIXTURE}:reset`)
  .digest('hex');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try {
  const r=await client.query(
    'SELECT allowed,retry_after_seconds FROM public.consume_invitation_rate_limit($1,$2,$3)',
    ['issue','actor',digest]);
  assert.deepEqual(r.rows,[{allowed:true,retry_after_seconds:0}]);
  console.log('PASS: expired counter reset to an allowed request');
} finally {await client.end();}
NODE
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v reset="${DIGESTS[5]}" <<'SQL'
SELECT set_config('test.rate_reset', :'reset', false);
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.invitation_rate_limits WHERE
    action='issue' AND bucket_kind='actor' AND
    bucket_digest=current_setting('test.rate_reset') AND attempts=1) THEN
    RAISE EXCEPTION 'Counter reset did not set attempts to one';
  END IF;
END;
$check$;
SQL

echo 'PASS: shared persistent rate limits, atomic counters, fixed quotas and cleanup checks complete'
