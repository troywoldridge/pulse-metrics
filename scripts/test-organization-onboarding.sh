#!/usr/bin/env bash
# Local-only integration test of atomic organization onboarding and privileges.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then echo 'ERROR: .env missing' >&2; exit 1; fi
command -v sudo >/dev/null || { echo 'ERROR: sudo missing' >&2; exit 1; }

node --env-file=.env --input-type=module <<'NODE'
const value=process.env.DATABASE_URL;
if (!value) throw Error('Missing DATABASE_URL');
const u=new URL(value);
if (!['postgres:','postgresql:'].includes(u.protocol) ||
    !['127.0.0.1','localhost','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1))!=='pulse_metrics' ||
    decodeURIComponent(u.username)!=='pulse_metrics_app' ||
    process.env.NODE_ENV==='production') {
  throw Error('Refusing to test anything except the local development runtime database');
}
console.log('PASS: Safe local database and runtime role');
NODE

SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
SUBJECT_A="user_pulse_org_fixture_${SUFFIX}_a"
SUBJECT_B="user_pulse_org_fixture_${SUFFIX}_b"
SLUG_A="pulse-org-a-${SUFFIX}"
SLUG_B="pulse-org-b-${SUFFIX}"
export SUBJECT_A SUBJECT_B SLUG_A SLUG_B

cleanup() {
  local original=$?
  trap - EXIT
  set +e
  echo '========== REMOVE TEST-ONLY FIXTURES =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" \
    -v subject_a="$SUBJECT_A" -v subject_b="$SUBJECT_B" <<'SQL'
BEGIN;
DELETE FROM public.audit_events WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b'));
DELETE FROM public.organization_memberships WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b'));
DELETE FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b');
DELETE FROM public.users WHERE auth_provider='workos'
  AND auth_subject IN (:'subject_a',:'subject_b');
COMMIT;
SQL
  local clean=$?
  if [[ "$clean" -ne 0 ]]; then
    echo 'ERROR: Test fixture cleanup failed — inspect the database' >&2
    exit 1
  fi
  exit "$original"
}
trap cleanup EXIT

echo '========== SECURITY DEFINER AND PERMISSION AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics <<'SQL'
DO $assert$
DECLARE
  v_ok boolean;
  v_public_execute boolean;
BEGIN
  SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolinherit
     AND rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
  INTO v_ok FROM pg_roles WHERE rolname = 'pulse_metrics_onboarding_executor';
  IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unexpected onboarding role privileges'; END IF;

  IF EXISTS (SELECT 1 FROM pg_auth_members
             WHERE roleid='pulse_metrics_onboarding_executor'::regrole
                OR member='pulse_metrics_onboarding_executor'::regrole) THEN
    RAISE EXCEPTION 'Onboarding executor role has a role membership';
  END IF;

  SELECT p.prosecdef AND p.proowner='pulse_metrics_onboarding_executor'::regrole
    AND 'search_path=pg_catalog, pg_temp'=ANY(p.proconfig)
  INTO v_ok FROM pg_proc p
  WHERE p.oid=to_regprocedure('public.create_workos_organization(text,text,text)');
  IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Unsafe onboarding function owner/config'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid=to_regprocedure('public.create_workos_organization(text,text,text)')
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
  ) INTO v_public_execute;
  IF v_public_execute IS DISTINCT FROM false THEN RAISE EXCEPTION 'PUBLIC EXECUTE exposed'; END IF;

  IF NOT has_function_privilege('pulse_metrics_app',
      'public.create_workos_organization(text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Runtime cannot invoke approved function';
  END IF;

  IF has_table_privilege('pulse_metrics_app','public.organizations','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.users','INSERT') THEN
    RAISE EXCEPTION 'Runtime role gained direct identity/org writes';
  END IF;

  IF has_table_privilege('pulse_metrics_onboarding_executor','public.users','UPDATE')
     OR has_table_privilege('pulse_metrics_onboarding_executor','public.users','INSERT')
     OR has_table_privilege('pulse_metrics_onboarding_executor','public.organizations','UPDATE')
     OR has_table_privilege('pulse_metrics_onboarding_executor','public.organizations','DELETE')
     OR has_table_privilege('pulse_metrics_onboarding_executor','public.organization_memberships','UPDATE')
     OR has_table_privilege('pulse_metrics_onboarding_executor','public.organization_memberships','DELETE')
     OR has_table_privilege('pulse_metrics_onboarding_executor','public.audit_events','DELETE') THEN
    RAISE EXCEPTION 'Onboarding executor has excessive table privileges';
  END IF;
END;
$assert$;
SQL

node --env-file=.env --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import pg from 'pg';
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try {
  const role=await client.query('SELECT current_user AS role');
  assert.equal(role.rows[0].role,'pulse_metrics_app');
  const subjectA=process.env.SUBJECT_A;
  const subjectB=process.env.SUBJECT_B;
  const slugA=process.env.SLUG_A;
  const slugB=process.env.SLUG_B;

  const userA=(await client.query('SELECT public.resolve_workos_user($1) AS id',[subjectA])).rows[0].id;
  const userB=(await client.query('SELECT public.resolve_workos_user($1) AS id',[subjectB])).rows[0].id;
  assert.notEqual(userA,userB);
  console.log('PASS: Two independent verified-subject test users provisioned');

  async function create(subject,name,slug) {
    return client.query('SELECT * FROM public.create_workos_organization($1,$2,$3)',[subject,name,slug]);
  }
  const one=(await create(subjectA,'  Test Company A  ',slugA)).rows[0];
  const two=(await create(subjectB,'Test Company B',slugB)).rows[0];
  assert.notEqual(one.organization_id,two.organization_id);
  assert.equal(one.membership_role,'owner');
  assert.equal(one.organization_slug,slugA);
  assert.equal(two.membership_role,'owner');
  console.log('PASS: organization creation returns distinct IDs and fixed owner roles');

  await assert.rejects(create(subjectA,'Another Company',slugB),error=>error.code==='23505');
  await assert.rejects(create('user_missing_'+process.env.SLUG_A,'Missing',`missing-${slugA}`),error=>error.code==='P0002');
  await assert.rejects(create('invalid subject','Bad',`invalid-${slugA}`),error=>error.code==='22023');
  await assert.rejects(create(subjectA,'   ',`empty-${slugA}`),error=>error.code==='22023');
  await assert.rejects(create(subjectA,'Bad','UPPERCASE'),error=>error.code==='22023');
  console.log('PASS: duplicate slug, unknown identity, bad inputs rejected');

  await assert.rejects(
    client.query('INSERT INTO public.organizations(name,slug) VALUES($1,$2)', ['Forged', `direct-${slugA}`]),
    error=>error.code==='42501');
  await assert.rejects(
    client.query('INSERT INTO public.organization_memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
      [one.organization_id,userB,'owner']), error=>error.code==='42501');
  console.log('PASS: application role cannot forge organization or owner membership');

  // RLS membership is visible to the correct user only when transaction-local
  // identity is set by the trusted API. A direct compromised DB connection can
  // forge custom settings; this test is not a substitute for API authentication.
  async function checkScope(userId,own,other) {
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1,$2,true)', ['app.current_organization_id','']);
      await client.query('SELECT set_config($1,$2,true)', ['app.current_user_id',userId]);
      const memberships=await client.query(
        'SELECT organization_id,role FROM public.organization_memberships ORDER BY organization_id');
      assert.deepEqual(memberships.rows,[{organization_id:own,role:'owner'}]);
      await client.query('SELECT set_config($1,$2,true)', ['app.current_organization_id',own]);
      const organizations=await client.query('SELECT id,name FROM public.organizations ORDER BY id');
      assert.equal(organizations.rowCount,1);
      assert.equal(organizations.rows[0].id,own);
      const audit=await client.query('SELECT event_type, actor_user_id FROM public.audit_events');
      assert.equal(audit.rowCount,1);
      assert.equal(audit.rows[0].event_type,'organization.created');
      assert.equal(audit.rows[0].actor_user_id,userId);
      const invisible=await client.query('SELECT id FROM public.organizations WHERE id=$1',[other]);
      assert.equal(invisible.rowCount,0);
    } finally { await client.query('ROLLBACK'); }
  }
  await checkScope(userA,one.organization_id,two.organization_id);
  await checkScope(userB,two.organization_id,one.organization_id);
  const unscoped=await client.query('SELECT id FROM public.organizations');
  assert.equal(unscoped.rowCount,0);
  console.log('PASS: owner memberships, audit records, two-way tenant RLS, context cleanup');
} finally {await client.end();}
NODE

echo 'PASS: All organization onboarding integration checks passed'
