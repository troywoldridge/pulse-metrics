#!/usr/bin/env bash
# Local-only invitation issuance integration test. No email or delivery occurs.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: missing .env' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo not installed' >&2; exit 1; }

node --env-file=.env --input-type=module <<'NODE'
const raw=process.env.DATABASE_URL;
if (!raw) throw Error('Missing local DATABASE_URL');
const u=new URL(raw);
if (!['postgres:','postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1))!=='pulse_metrics' ||
    decodeURIComponent(u.username)!=='pulse_metrics_app' ||
    process.env.NODE_ENV==='production') {
  throw Error('Refusing invitation fixture operations on unsafe database target');
}
console.log('PASS: local database and restricted runtime role');
NODE

SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
SUBJECT_OWNER_A="user_pulse_invite_${SUFFIX}_oa"
SUBJECT_ADMIN_A="user_pulse_invite_${SUFFIX}_aa"
SUBJECT_MEMBER_A="user_pulse_invite_${SUFFIX}_ma"
SUBJECT_VIEWER_A="user_pulse_invite_${SUFFIX}_va"
SUBJECT_OWNER_B="user_pulse_invite_${SUFFIX}_ob"
SUBJECT_OUTSIDER="user_pulse_invite_${SUFFIX}_x"
SLUG_A="pulse-invite-a-${SUFFIX}"
SLUG_B="pulse-invite-b-${SUFFIX}"
export SUBJECT_OWNER_A SUBJECT_ADMIN_A SUBJECT_MEMBER_A SUBJECT_VIEWER_A SUBJECT_OWNER_B SUBJECT_OUTSIDER SUFFIX

cleanup() {
  local original=$?
  trap - EXIT
  set +e
  echo '========== REMOVE INVITATION TEST FIXTURES =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" \
    -v owner_a="$SUBJECT_OWNER_A" -v admin_a="$SUBJECT_ADMIN_A" \
    -v member_a="$SUBJECT_MEMBER_A" -v viewer_a="$SUBJECT_VIEWER_A" \
    -v owner_b="$SUBJECT_OWNER_B" -v outsider="$SUBJECT_OUTSIDER" <<'SQL'
BEGIN;
DELETE FROM public.organization_invitations WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a', :'slug_b'));
DELETE FROM public.audit_events WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a', :'slug_b'));
DELETE FROM public.organization_memberships WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a', :'slug_b'));
DELETE FROM public.organizations WHERE slug IN (:'slug_a', :'slug_b');
DELETE FROM public.users WHERE auth_provider='workos' AND auth_subject IN
  (:'owner_a', :'admin_a', :'member_a', :'viewer_a', :'owner_b', :'outsider');
COMMIT;
SQL
  local cleanup_result=$?
  if [[ "$cleanup_result" -ne 0 ]]; then
    echo 'ERROR: invitation fixture cleanup failed; inspect local database' >&2
    exit 1
  fi
  exit "$original"
}
trap cleanup EXIT

echo '========== PRIVILEGE, OWNER AND RLS AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics <<'SQL'
DO $audit$
DECLARE
  executor_ok boolean;
  function_ok boolean;
  public_exec boolean;
  table_ok boolean;
BEGIN
  SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolinherit AND rolbypassrls
     AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
    INTO executor_ok FROM pg_roles WHERE rolname='pulse_metrics_invitation_executor';
  IF executor_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Invitation executor attributes invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE
    roleid='pulse_metrics_invitation_executor'::regrole OR
    member='pulse_metrics_invitation_executor'::regrole) THEN
    RAISE EXCEPTION 'Invitation executor membership is forbidden';
  END IF;
  SELECT p.prosecdef AND p.proowner='pulse_metrics_invitation_executor'::regrole
    AND 'search_path=pg_catalog, pg_temp'=ANY(p.proconfig)
  INTO function_ok FROM pg_proc p WHERE p.oid=to_regprocedure(
    'public.issue_organization_invitation(text,uuid,text,text,text,timestamp with time zone)');
  IF function_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Invitation function owner or search_path invalid';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid=to_regprocedure(
      'public.issue_organization_invitation(text,uuid,text,text,text,timestamp with time zone)')
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE') INTO public_exec;
  IF public_exec IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PUBLIC can execute invitation function';
  END IF;
  SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND c.relowner='pulse_metrics_migrator'::regrole
    INTO table_ok FROM pg_class c WHERE c.oid='public.organization_invitations'::regclass;
  IF table_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Invitation table owner or forced RLS invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
     AND tablename='organization_invitations') THEN
    RAISE EXCEPTION 'Invitation table unexpectedly has access policies';
  END IF;
  IF has_table_privilege('pulse_metrics_app','public.organization_invitations','SELECT')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','DELETE') THEN
    RAISE EXCEPTION 'Runtime granted direct invitation table access';
  END IF;
  IF has_table_privilege('pulse_metrics_invitation_executor','public.organization_invitations','UPDATE')
     OR has_table_privilege('pulse_metrics_invitation_executor','public.organization_invitations','DELETE')
     OR has_table_privilege('pulse_metrics_invitation_executor','public.organization_memberships','INSERT')
     OR has_table_privilege('pulse_metrics_invitation_executor','public.organization_memberships','UPDATE')
     OR has_table_privilege('pulse_metrics_invitation_executor','public.organization_memberships','DELETE') THEN
    RAISE EXCEPTION 'Invitation executor gained direct membership modification';
  END IF;
  IF NOT has_function_privilege('pulse_metrics_app',
    'public.issue_organization_invitation(text,uuid,text,text,text,timestamp with time zone)',
    'EXECUTE') THEN
    RAISE EXCEPTION 'Runtime cannot execute invitation issuance function';
  END IF;
END;
$audit$;
SQL

echo '========== CREATE TEMPORARY ROLE FIXTURES =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" \
  -v owner_a="$SUBJECT_OWNER_A" -v admin_a="$SUBJECT_ADMIN_A" \
  -v member_a="$SUBJECT_MEMBER_A" -v viewer_a="$SUBJECT_VIEWER_A" \
  -v owner_b="$SUBJECT_OWNER_B" -v outsider="$SUBJECT_OUTSIDER" <<'SQL'
BEGIN;
INSERT INTO public.users(auth_provider,auth_subject) VALUES
  ('workos',:'owner_a'),('workos',:'admin_a'),('workos',:'member_a'),
  ('workos',:'viewer_a'),('workos',:'owner_b'),('workos',:'outsider');
INSERT INTO public.organizations(name,slug) VALUES
  ('Synthetic Invitation Test A',:'slug_a'),('Synthetic Invitation Test B',:'slug_b');
INSERT INTO public.organization_memberships(organization_id,user_id,role)
SELECT o.id,u.id,v.role::public.membership_role
FROM (VALUES
  (:'slug_a',:'owner_a','owner'),(:'slug_a',:'admin_a','admin'),
  (:'slug_a',:'member_a','member'),(:'slug_a',:'viewer_a','viewer'),
  (:'slug_b',:'owner_b','owner')
) AS v(slug,subject,role)
JOIN public.organizations o ON o.slug=v.slug
JOIN public.users u ON u.auth_provider='workos' AND u.auth_subject=v.subject;
COMMIT;
SQL

mapfile -t ORG_IDS < <(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off \
  -d pulse_metrics -At -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" <<'SQL'
SELECT id FROM public.organizations WHERE slug=:'slug_a';
SELECT id FROM public.organizations WHERE slug=:'slug_b';
SQL
)
[[ "${#ORG_IDS[@]}" -eq 2 ]] || { echo 'ERROR: missing fixture organizations' >&2; exit 1; }
export ORG_A="${ORG_IDS[0]}" ORG_B="${ORG_IDS[1]}"

echo '========== RESTRICTED APPLICATION DATABASE TESTS =========='
node --env-file=.env --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
const db = new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
const digest = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const expire = () => new Date(Date.now()+24*3600_000);
const {ORG_A:a,ORG_B:b,SUBJECT_OWNER_A:ownerA,SUBJECT_ADMIN_A:adminA,
  SUBJECT_MEMBER_A:memberA,SUBJECT_VIEWER_A:viewerA,
  SUBJECT_OWNER_B:ownerB,SUBJECT_OUTSIDER:outsider,SUFFIX:suffix}=process.env;
const issue=(subject,org,email,role,hash=digest(),expiry=expire()) =>
  db.query('SELECT public.issue_organization_invitation($1,$2,$3,$4,$5,$6) AS id',
    [subject,org,email,role,hash,expiry]);
const deny=async(promise,code)=>assert.rejects(promise,e=>e.code===code);
try {
  const role=await db.query('SELECT current_user AS name');
  assert.equal(role.rows[0].name,'pulse_metrics_app');

  const key=digest();
  const first=await issue(ownerA,a,`  Alice.${suffix}@EXAMPLE.INVALID  `,'member',key);
  assert.match(first.rows[0].id,/^[0-9a-f-]{36}$/);
  await issue(adminA,a,`bob.${suffix}@example.invalid`,'viewer');
  await issue(ownerA,a,`carol.${suffix}@example.invalid`,'admin');
  await issue(ownerB,b,`dan.${suffix}@example.invalid`,'member');
  console.log('PASS: owner/admin issuance and owner-only admin invitations');

  await deny(issue(adminA,a,`bad.${suffix}@example.invalid`,'admin'),'42501');
  await deny(issue(memberA,a,`bad.${suffix}@example.invalid`,'viewer'),'42501');
  await deny(issue(viewerA,a,`bad.${suffix}@example.invalid`,'member'),'42501');
  await deny(issue(ownerB,a,`bad.${suffix}@example.invalid`,'member'),'42501');
  await deny(issue(ownerA,b,`bad.${suffix}@example.invalid`,'member'),'42501');
  await deny(issue(outsider,a,`bad.${suffix}@example.invalid`,'member'),'42501');
  await deny(issue('user_unknown_fixture',a,`bad.${suffix}@example.invalid`,'member'),'42501');
  console.log('PASS: no cross-tenant, member, viewer or outsider issuance');

  await deny(issue(ownerA,a,`bad.${suffix}@example.invalid`,'owner'),'22023');
  await deny(issue(ownerA,a,'not-email','member'),'22023');
  await deny(issue(ownerA,a,`bad.${suffix}@example.invalid`,'member','invalid'),'22023');
  await deny(issue(ownerA,a,`bad.${suffix}@example.invalid`,'viewer',digest(),new Date(Date.now()+8*86400000)),'22023');
  await deny(issue(ownerA,a,`bad.${suffix}@example.invalid`,'viewer',digest(),new Date(Date.now()-1000)),'22023');
  await deny(issue(ownerA,a,`bad.${suffix}@example.invalid`,'member',key),'23505');
  console.log('PASS: owner role, bad inputs, expiry windows and duplicate digests rejected');

  await deny(db.query('SELECT * FROM public.organization_invitations'),'42501');
  await deny(db.query('INSERT INTO public.organization_invitations(organization_id,invited_email,invited_role,token_hash,created_by_user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [a,`bad.${suffix}@example.invalid`,'member',digest(),'00000000-0000-4000-8000-000000000000',expire()]),'42501');
  await deny(db.query('INSERT INTO public.organization_memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
    [a,'00000000-0000-4000-8000-000000000000','owner']),'42501');
  console.log('PASS: runtime has no direct invitation or membership writes');
} finally {await db.end();}
NODE

echo '========== VERIFY ACTUAL HASHES AND AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" <<'SQL'
SELECT set_config('test.invitation_slug_a', :'slug_a', false),
       set_config('test.invitation_slug_b', :'slug_b', false);
DO $verify$
DECLARE
  org_a uuid;
  org_b uuid;
BEGIN
  SELECT id INTO org_a FROM public.organizations WHERE slug=current_setting('test.invitation_slug_a');
  SELECT id INTO org_b FROM public.organizations WHERE slug=current_setting('test.invitation_slug_b');
  IF (SELECT count(*) FROM public.organization_invitations WHERE organization_id=org_a)<>3
     OR (SELECT count(*) FROM public.organization_invitations WHERE organization_id=org_b)<>1 THEN
    RAISE EXCEPTION 'Expected exactly 3 A invitations and 1 B invitation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_invitations WHERE
      organization_id IN (org_a,org_b) AND (invited_email<>lower(invited_email) OR
      length(token_hash)<>64 OR
      consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR
      consumed_by_user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Invalid initial invite state';
  END IF;
  IF (SELECT count(*) FROM public.audit_events WHERE
      organization_id=org_a AND event_type='organization.invitation.created')<>3
     OR (SELECT count(*) FROM public.audit_events WHERE
      organization_id=org_b AND event_type='organization.invitation.created')<>1 THEN
    RAISE EXCEPTION 'Invitation audit events do not match';
  END IF;
END;
$verify$;
SQL

echo 'PASS: All restricted-role invitation issuance checks passed; no memberships created by invitations.'
