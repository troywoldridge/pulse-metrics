#!/usr/bin/env bash
# Pulse Metrics Phase 2E3C1: local-only real PostgreSQL acceptance tests.
# Uses synthetic WorkOS-shaped subjects. DOES NOT test real WorkOS email proof.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: missing local .env' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo required for fixture cleanup' >&2; exit 1; }
command -v node >/dev/null || { echo 'ERROR: Node.js required' >&2; exit 1; }

node --env-file=.env --input-type=module <<'NODE'
const raw=process.env.DATABASE_URL;
if (!raw) throw Error('DATABASE_URL is required');
const u=new URL(raw);
if (!['postgres:','postgresql:'].includes(u.protocol) ||
    !['127.0.0.1','localhost','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1))!=='pulse_metrics' ||
    decodeURIComponent(u.username)!=='pulse_metrics_app' ||
    process.env.NODE_ENV==='production') {
  throw Error('Refusing fixture operations: unsafe database or role');
}
console.log('PASS: local pulse_metrics database, restricted runtime role');
NODE

umask 077
SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
SLUG_A="pulse-accept-a-${SUFFIX}"
SLUG_B="pulse-accept-b-${SUFFIX}"
OWNER_A="user_pulse_accept_${SUFFIX}_owner_a"
OWNER_B="user_pulse_accept_${SUFFIX}_owner_b"
ALICE="user_pulse_accept_${SUFFIX}_alice"
BOB="user_pulse_accept_${SUFFIX}_bob"
UNVERIFIED="user_pulse_accept_${SUFFIX}_unverified"
WRONG="user_pulse_accept_${SUFFIX}_wrong"
EXISTING="user_pulse_accept_${SUFFIX}_existing"
HASH_FILE="$(mktemp /tmp/pulse-invite-acceptance-hashes-XXXXXX)"
export SUFFIX SLUG_A SLUG_B OWNER_A OWNER_B ALICE BOB UNVERIFIED WRONG EXISTING HASH_FILE

cleanup() {
  local original=$?
  trap - EXIT
  set +e
  rm -f -- "$HASH_FILE"
  echo '========== CLEAN UP SYNTHETIC ACCEPTANCE FIXTURES =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" \
    -v owner_a="$OWNER_A" -v owner_b="$OWNER_B" \
    -v alice="$ALICE" -v bob="$BOB" -v unverified="$UNVERIFIED" \
    -v wrong="$WRONG" -v existing="$EXISTING" <<'SQL'
BEGIN;
DELETE FROM public.organization_invitations WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b'));
DELETE FROM public.audit_events WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b'));
DELETE FROM public.organization_memberships WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b'));
DELETE FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b');
DELETE FROM public.users WHERE auth_provider='workos' AND auth_subject IN
  (:'owner_a',:'owner_b',:'alice',:'bob',:'unverified',:'wrong',:'existing');
COMMIT;
SQL
  local clean_result=$?
  if [[ "$clean_result" -ne 0 ]]; then
    echo 'ERROR: cleanup failed; inspect development database before retrying' >&2
    exit 1
  fi
  echo 'PASS: synthetic acceptance fixtures cleaned up'
  exit "$original"
}
trap cleanup EXIT

echo '========== SECURITY DEFINER, RLS AND GRANT AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics <<'SQL'
DO $audit$
DECLARE
  executor_ok boolean;
  function_ok boolean;
  public_exec boolean;
  invitation_rls_ok boolean;
BEGIN
  SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolinherit
    AND rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
  INTO executor_ok FROM pg_roles WHERE rolname='pulse_metrics_acceptance_executor';
  IF executor_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Acceptance executor role attributes invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE
    roleid='pulse_metrics_acceptance_executor'::regrole OR
    member='pulse_metrics_acceptance_executor'::regrole) THEN
    RAISE EXCEPTION 'Acceptance executor role membership invalid';
  END IF;
  SELECT p.prosecdef AND p.proowner='pulse_metrics_acceptance_executor'::regrole
      AND 'search_path=pg_catalog, pg_temp'=ANY(p.proconfig)
  INTO function_ok FROM pg_proc p WHERE p.oid=to_regprocedure(
    'public.accept_organization_invitation(text,text)');
  IF function_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Acceptance function owner or search_path invalid';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_proc p,
     LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
   WHERE p.oid=to_regprocedure('public.accept_organization_invitation(text,text)')
     AND acl.grantee=0 AND acl.privilege_type='EXECUTE') INTO public_exec;
  IF public_exec IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PUBLIC execute permission is forbidden';
  END IF;
  SELECT c.relrowsecurity AND c.relforcerowsecurity
     AND c.relowner='pulse_metrics_migrator'::regrole
  INTO invitation_rls_ok FROM pg_class c
  WHERE c.oid=to_regclass('public.organization_invitations');
  IF invitation_rls_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Invitation table RLS/owner invalid';
  END IF;
  IF has_table_privilege('pulse_metrics_app','public.organization_memberships','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.users','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','SELECT') THEN
    RAISE EXCEPTION 'Runtime role has unsafe direct permissions';
  END IF;
  IF has_table_privilege('pulse_metrics_acceptance_executor','public.users','UPDATE')
     OR has_table_privilege('pulse_metrics_acceptance_executor','public.organization_memberships','UPDATE')
     OR has_table_privilege('pulse_metrics_acceptance_executor','public.organization_memberships','DELETE')
     OR has_table_privilege('pulse_metrics_acceptance_executor','public.organization_invitations','DELETE') THEN
    RAISE EXCEPTION 'Acceptance executor has unsafe write permissions';
  END IF;
  IF NOT has_function_privilege('pulse_metrics_app',
       'public.accept_organization_invitation(text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Runtime role cannot execute acceptance function';
  END IF;
END;
$audit$;
SQL

echo '========== CREATE TWO TEMPORARY ORGANIZATIONS AND TEST USERS =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" -v suffix="$SUFFIX" \
  -v owner_a="$OWNER_A" -v owner_b="$OWNER_B" \
  -v alice="$ALICE" -v bob="$BOB" -v unverified="$UNVERIFIED" \
  -v wrong="$WRONG" -v existing="$EXISTING" <<'SQL'
BEGIN;
INSERT INTO public.users (auth_provider,auth_subject,email,email_verified_at) VALUES
  ('workos',:'owner_a',NULL,NULL),
  ('workos',:'owner_b',NULL,NULL),
  ('workos',:'alice','alice.'||:'suffix'||'@example.invalid',statement_timestamp()-interval '1 hour'),
  ('workos',:'bob','bob.'||:'suffix'||'@example.invalid',statement_timestamp()-interval '1 hour'),
  ('workos',:'unverified','unverified.'||:'suffix'||'@example.invalid',NULL),
  ('workos',:'wrong','wrong.'||:'suffix'||'@example.invalid',statement_timestamp()-interval '1 hour'),
  ('workos',:'existing','existing.'||:'suffix'||'@example.invalid',statement_timestamp()-interval '1 hour');
INSERT INTO public.organizations(name,slug) VALUES
  ('Synthetic Acceptance Test A',:'slug_a'),
  ('Synthetic Acceptance Test B',:'slug_b');
INSERT INTO public.organization_memberships(organization_id,user_id,role)
SELECT o.id,u.id,roles.role::public.membership_role FROM (VALUES
  (:'slug_a',:'owner_a','owner'),
  (:'slug_b',:'owner_b','owner'),
  (:'slug_a',:'existing','member')
) AS roles(slug,subject,role)
JOIN public.organizations o ON o.slug=roles.slug
JOIN public.users u ON u.auth_provider='workos' AND u.auth_subject=roles.subject;
COMMIT;
SQL

mapfile -t ORG_IDS < <(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off \
  -d pulse_metrics -At -v a="$SLUG_A" -v b="$SLUG_B" <<'SQL'
SELECT id FROM public.organizations WHERE slug=:'a';
SELECT id FROM public.organizations WHERE slug=:'b';
SQL
)
[[ "${#ORG_IDS[@]}" == 2 ]] || { echo 'ERROR: fixture organizations missing' >&2; exit 1; }
export ORG_A="${ORG_IDS[0]}" ORG_B="${ORG_IDS[1]}"

echo '========== REAL RESTRICTED-ROLE ACCEPTANCE TESTS =========='
node --env-file=.env --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import pg from 'pg';
const db = new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});
const {ORG_A:A,ORG_B:B,OWNER_A:ownerA,OWNER_B:ownerB,
 ALICE:alice,BOB:bob,UNVERIFIED:unverified,WRONG:wrong,
 EXISTING:existing,SUFFIX:suffix,HASH_FILE:hashFile} = process.env;
const digest=()=>createHash('sha256').update(randomBytes(32)).digest('hex');
const issue=(actor,org,email,role,hash)=>db.query(
  'SELECT public.issue_organization_invitation($1,$2,$3,$4,$5,$6) AS id',
  [actor,org,email,role,hash,new Date(Date.now()+24*3600_000)]);
const accept=(subject,hash)=>db.query(
  'SELECT organization_id,membership_role FROM public.accept_organization_invitation($1,$2)',
  [subject,hash]);
const deny=(promise,code)=>assert.rejects(promise,e=>e?.code===code);
const email=n=>`${n}.${suffix}@example.invalid`;
try {
  assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,'pulse_metrics_app');
  const aliceA=digest();
  await issue(ownerA,A,email('alice'),'member',aliceA);
  await deny(accept(wrong,aliceA),'P0002');
  await deny(accept('user_missing_synthetic',aliceA),'P0002');
  await deny(accept(alice,'not-a-digest'),'22023');
  const a1=await accept(alice,aliceA);
  assert.equal(a1.rows[0].organization_id,A);
  assert.equal(a1.rows[0].membership_role,'member');
  await deny(accept(alice,aliceA),'P0002');
  console.log('PASS: verified recipient match, exact org/role, replay denied');

  const pending=digest();
  await issue(ownerA,A,email('unverified'),'viewer',pending);
  await deny(accept(unverified,pending),'P0002');
  console.log('PASS: unverified database email cannot accept an invitation');

  const race=digest();
  await issue(ownerA,A,email('bob'),'viewer',race);
  const outcomes=await Promise.allSettled([accept(bob,race),accept(bob,race)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(o=>o.status==='rejected'&&o.reason?.code==='P0002').length,1);
  const winner=outcomes.find(o=>o.status==='fulfilled');
  assert.equal(winner.value.rows[0].organization_id,A);
  assert.equal(winner.value.rows[0].membership_role,'viewer');
  console.log('PASS: concurrent acceptance permits exactly one winner');

  const existingInvitation=digest();
  await issue(ownerA,A,email('existing'),'viewer',existingInvitation);
  await deny(accept(existing,existingInvitation),'23505');
  console.log('PASS: existing membership cannot be overwritten or promoted');

  const aliceB=digest();
  await issue(ownerB,B,email('alice'),'admin',aliceB);
  const b1=await accept(alice,aliceB);
  assert.equal(b1.rows[0].organization_id,B);
  assert.equal(b1.rows[0].membership_role,'admin');
  console.log('PASS: invitation binds membership to invitation org, not caller-selected org');

  const expired=digest();
  const revoked=digest();
  await issue(ownerB,B,email('bob'),'viewer',expired);
  await issue(ownerB,B,email('bob'),'member',revoked);
  fs.writeFileSync(hashFile,JSON.stringify({expired,revoked}),{mode:0o600});
  console.log('PASS: expiry and revocation fixtures issued (no secrets displayed)');

  await deny(db.query('UPDATE public.users SET email_verified_at=now() WHERE auth_subject=$1',[unverified]),'42501');
  await deny(db.query('INSERT INTO public.organization_memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
   [A,'00000000-0000-4000-8000-000000000000','owner']),'42501');
  await deny(db.query('SELECT * FROM public.organization_invitations'),'42501');
  console.log('PASS: runtime cannot forge verified email, membership or invitation table reads');
} finally {await db.end();}
NODE

echo '========== EXPIRE AND REVOKE SYNTHETIC INVITATIONS =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug_b="$SLUG_B" -v suffix="$SUFFIX" <<'SQL'
BEGIN;
UPDATE public.organization_invitations i
SET expires_at=statement_timestamp()-interval '1 minute'
FROM public.organizations o
WHERE i.organization_id=o.id AND o.slug=:'slug_b'
  AND i.invited_email='bob.'||:'suffix'||'@example.invalid'
  AND i.invited_role='viewer';
UPDATE public.organization_invitations i
SET revoked_at=statement_timestamp()
FROM public.organizations o
WHERE i.organization_id=o.id AND o.slug=:'slug_b'
  AND i.invited_email='bob.'||:'suffix'||'@example.invalid'
  AND i.invited_role='member';
COMMIT;
SQL

echo '========== EXPIRED AND REVOKED TOKEN REJECTION =========='
node --env-file=.env --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
const {expired,revoked}=JSON.parse(fs.readFileSync(process.env.HASH_FILE,'utf8'));
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
try {
  for (const hash of [expired,revoked]) {
    await assert.rejects(db.query(
      'SELECT * FROM public.accept_organization_invitation($1,$2)',
      [process.env.BOB,hash]),e=>e?.code==='P0002');
  }
  console.log('PASS: expired and revoked invitations cannot be accepted');
} finally {await db.end();}
NODE

echo '========== VERIFY ATOMICITY, MEMBERSHIPS AND AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v a="$SLUG_A" -v b="$SLUG_B" -v suffix="$SUFFIX" <<'SQL'
SELECT set_config('pulse_test.slug_a', :'a', false),
       set_config('pulse_test.slug_b', :'b', false),
       set_config('pulse_test.suffix', :'suffix', false);
DO $verify$
DECLARE
 a uuid;
 b uuid;
 total integer;
BEGIN
 SELECT id INTO a FROM public.organizations WHERE slug=current_setting('pulse_test.slug_a');
 SELECT id INTO b FROM public.organizations WHERE slug=current_setting('pulse_test.slug_b');
 IF a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'Missing fixtures'; END IF;
 IF (SELECT count(*) FROM public.organization_invitations WHERE organization_id IN (a,b))<>7 THEN
   RAISE EXCEPTION 'Expected seven issued invitations';
 END IF;
 IF (SELECT count(*) FROM public.organization_invitations WHERE organization_id IN (a,b)
       AND consumed_at IS NOT NULL AND consumed_by_user_id IS NOT NULL)<>3 THEN
   RAISE EXCEPTION 'Expected exactly three consumed invitations';
 END IF;
 IF (SELECT count(*) FROM public.organization_memberships WHERE organization_id=a)<>4
 OR (SELECT count(*) FROM public.organization_memberships WHERE organization_id=b)<>2 THEN
   RAISE EXCEPTION 'Unexpected membership count';
 END IF;
 IF (SELECT count(*) FROM public.audit_events WHERE organization_id IN (a,b)
       AND event_type='organization.invitation.created')<>7
 OR (SELECT count(*) FROM public.audit_events WHERE organization_id IN (a,b)
       AND event_type='organization.invitation.accepted')<>3 THEN
   RAISE EXCEPTION 'Invitation issuance or acceptance audit count mismatch';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organization_memberships m
       JOIN public.users u ON u.id=m.user_id
       WHERE m.organization_id=a AND m.role='member'
         AND u.email='existing.'||current_setting('pulse_test.suffix')||'@example.invalid') THEN
   RAISE EXCEPTION 'Existing membership role was altered';
 END IF;
 IF EXISTS (SELECT 1 FROM public.organization_invitations i WHERE i.organization_id=a
       AND i.invited_email='existing.'||current_setting('pulse_test.suffix')||'@example.invalid'
       AND i.consumed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Failed duplicate acceptance consumed token';
 END IF;
END;
$verify$;
SQL

echo 'PASS: all restricted-role single-use acceptance checks passed'
