#!/usr/bin/env bash
# Phase 2E3C3: LOCAL ONLY. Creates and removes synthetic users and one org.
# Does not contact WorkOS or alter any real Pulse Metrics organizations.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: .env missing' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo is required' >&2; exit 1; }
node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw) throw Error('Local runtime database config required');
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1','localhost','::1'].includes(url.hostname.toLowerCase()) ||
    decodeURIComponent(url.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(url.username) !== 'pulse_metrics_app' ||
    process.env.NODE_ENV === 'production') {
  throw Error('Unsafe database target; fixtures refused');
}
console.log('PASS: local pulse_metrics database and restricted runtime role');
NODE

SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
SUBJECT_OWNER="user_pulse_emailsync_${SUFFIX}_owner"
SUBJECT_RECIPIENT="user_pulse_emailsync_${SUFFIX}_recipient"
SUBJECT_OTHER="user_pulse_emailsync_${SUFFIX}_other"
SLUG="pulse-emailsync-${SUFFIX}"
EMAIL="recipient.${SUFFIX}@example.invalid"
NEXT_EMAIL="new.${SUFFIX}@example.invalid"
export SUBJECT_OWNER SUBJECT_RECIPIENT SUBJECT_OTHER EMAIL NEXT_EMAIL SUFFIX

cleanup() {
  local initial_status=$?
  trap - EXIT
  set +e
  echo '========== CLEAN UP SYNTHETIC VERIFIED-EMAIL FIXTURES =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v slug="$SLUG" -v owner="$SUBJECT_OWNER" \
    -v recipient="$SUBJECT_RECIPIENT" -v other="$SUBJECT_OTHER" <<'SQL'
BEGIN;
DELETE FROM public.organization_invitations WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug=:'slug');
DELETE FROM public.audit_events WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug=:'slug');
DELETE FROM public.organization_memberships WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug=:'slug');
DELETE FROM public.organizations WHERE slug=:'slug';
DELETE FROM public.users WHERE auth_provider='workos' AND auth_subject IN
  (:'owner', :'recipient', :'other');
COMMIT;
SQL
  local cleanup_status=$?
  if [[ "$cleanup_status" -ne 0 ]]; then
    echo 'ERROR: fixture cleanup failed; inspect local development database' >&2
    exit 1
  fi
  echo 'PASS: synthetic verified-email fixtures cleaned up'
  exit "$initial_status"
}
trap cleanup EXIT

echo '========== SECURITY DEFINER, GRANT AND RLS AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics <<'SQL'
DO $audit$
DECLARE
  r record;
  f record;
  public_exec boolean;
BEGIN
  SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
    rolreplication, rolbypassrls INTO r FROM pg_roles
    WHERE rolname='pulse_metrics_email_sync_executor';
  IF NOT FOUND OR r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
     OR r.rolcreaterole OR r.rolreplication OR NOT r.rolbypassrls THEN
    RAISE EXCEPTION 'Email sync executor has unsafe role attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE
    roleid='pulse_metrics_email_sync_executor'::regrole OR
    member='pulse_metrics_email_sync_executor'::regrole) THEN
    RAISE EXCEPTION 'Email sync executor role memberships forbidden';
  END IF;
  SELECT prosecdef, proowner, proconfig INTO f FROM pg_proc WHERE oid=
    'public.sync_workos_verified_email(text,text)'::regprocedure;
  IF NOT FOUND OR NOT f.prosecdef OR f.proowner<>'pulse_metrics_email_sync_executor'::regrole
    OR NOT ('search_path=pg_catalog, pg_temp'=ANY(f.proconfig)) THEN
    RAISE EXCEPTION 'Email sync function ownership or search_path unsafe';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_proc p,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid='public.sync_workos_verified_email(text,text)'::regprocedure
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE') INTO public_exec;
  IF public_exec THEN RAISE EXCEPTION 'PUBLIC EXECUTE forbidden'; END IF;
  IF NOT has_function_privilege('pulse_metrics_app',
      'public.sync_workos_verified_email(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Runtime cannot use restricted sync function';
  END IF;
  IF has_table_privilege('pulse_metrics_app', 'public.users', 'UPDATE')
     OR has_column_privilege('pulse_metrics_app','public.users','email','UPDATE')
     OR has_column_privilege('pulse_metrics_app','public.users','email_verified_at','UPDATE')
     OR has_table_privilege('pulse_metrics_email_sync_executor',
        'public.organization_memberships','INSERT')
     OR has_table_privilege('pulse_metrics_email_sync_executor',
        'public.organization_invitations','UPDATE')
     OR has_table_privilege('pulse_metrics_email_sync_executor',
        'public.audit_events','INSERT')
     OR NOT has_column_privilege('pulse_metrics_email_sync_executor',
        'public.users','email','UPDATE') THEN
    RAISE EXCEPTION 'Email sync privileges not least-privilege';
  END IF;
END;
$audit$;
SQL

echo '========== CREATE TEMPORARY IDENTITY AND ORGANIZATION FIXTURES =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug="$SLUG" -v owner="$SUBJECT_OWNER" \
  -v recipient="$SUBJECT_RECIPIENT" -v other="$SUBJECT_OTHER" <<'SQL'
BEGIN;
INSERT INTO public.users(auth_provider,auth_subject) VALUES
  ('workos',:'owner'),('workos',:'recipient'),('workos',:'other');
INSERT INTO public.organizations(name,slug) VALUES
  ('Synthetic Verified Email Sync Test',:'slug');
INSERT INTO public.organization_memberships(organization_id,user_id,role)
SELECT o.id,u.id,'owner' FROM public.organizations o
JOIN public.users u ON u.auth_provider='workos' AND u.auth_subject=:'owner'
WHERE o.slug=:'slug';
COMMIT;
SQL
ORG_ID="$(sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d pulse_metrics -v slug="$SLUG" <<'SQL'
SELECT id FROM public.organizations WHERE slug=:'slug';
SQL
)"
[[ "$ORG_ID" =~ ^[0-9a-f]{8}-[0-9a-f-]{27,}$ ]] || { echo 'ERROR: missing test organization UUID' >&2; exit 1; }
export ORG_ID

echo '========== RESTRICTED APPLICATION EMAIL SYNC AND ACCEPTANCE TESTS =========='
node --env-file=.env --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const {SUBJECT_OWNER:owner, SUBJECT_RECIPIENT:recipient,SUBJECT_OTHER:other,
  ORG_ID:org, EMAIL:email, NEXT_EMAIL:nextEmail} = process.env;
const digest=()=>createHash('sha256').update(randomBytes(32)).digest('hex');
const issue=(targetEmail,hash)=>client.query(
  'SELECT public.issue_organization_invitation($1,$2,$3,$4,$5,$6) AS id',
  [owner,org,targetEmail,'viewer',hash,new Date(Date.now()+24*3600_000)]);
const accept=(subject,hash)=>client.query(
  'SELECT * FROM public.accept_organization_invitation($1,$2)',[subject,hash]);
const sync=(subject,verifiedEmail)=>client.query(
  'SELECT public.sync_workos_verified_email($1,$2) AS user_id',
  [subject, verifiedEmail]);
const denied=(promise,code)=>assert.rejects(promise,e=>e.code===code);
try {
  const role=await client.query('SELECT current_user AS role');
  assert.equal(role.rows[0].role,'pulse_metrics_app');

  const hash=digest();
  await issue(email,hash);
  await denied(accept(recipient,hash),'P0002');
  console.log('PASS: invite cannot be accepted before verified-email synchronization');

  const emailSynced=await sync(recipient,`  ${email.toUpperCase()}  `);
  assert.match(emailSynced.rows[0].user_id,/^[0-9a-f-]{36}$/);
  const membership=await accept(recipient,hash);
  assert.equal(membership.rows[0].organization_id,org);
  assert.equal(membership.rows[0].membership_role,'viewer');
  await denied(accept(recipient,hash),'P0002');
  console.log('PASS: normalized verified email permits intended single-use invitation');

  // An explicit unverified provider response must remove stale evidence.
  const cleared=await sync(recipient,null);
  assert.equal(cleared.rows[0].user_id,emailSynced.rows[0].user_id);
  const secondHash=digest();
  await issue(email,secondHash);
  await denied(accept(recipient,secondHash),'P0002');
  console.log('PASS: unverified provider response clears acceptance evidence');

  await sync(recipient,nextEmail);
  await denied(accept(recipient,secondHash),'P0002');
  console.log('PASS: changed email cannot accept old-recipient invitation');

  await denied(sync(recipient,'not-an-email'),'22023');
  await denied(sync('bad\nsubject',email),'22023');
  await denied(sync('user_unknown_synthetic_subject',email),'P0002');
  await denied(client.query('UPDATE public.users SET email=$1 WHERE auth_subject=$2', [email,recipient]),'42501');
  await denied(client.query('UPDATE public.organization_memberships SET role=$1 WHERE organization_id=$2', ['owner',org]),'42501');
  console.log('PASS: direct writes and malformed inputs rejected for ordinary runtime role');
} finally { await client.end(); }
NODE

echo '========== VERIFY FINAL VERIFIED EMAIL STATES AND AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug="$SLUG" -v email="$EMAIL" -v next_email="$NEXT_EMAIL" \
  -v recipient="$SUBJECT_RECIPIENT" -v other="$SUBJECT_OTHER" <<'SQL'
SELECT set_config('test.emailsync_slug',:'slug',false),
       set_config('test.emailsync_email',:'email',false),
       set_config('test.emailsync_next_email',:'next_email',false),
       set_config('test.emailsync_recipient',:'recipient',false),
       set_config('test.emailsync_other',:'other',false);
DO $verify$
DECLARE
  org uuid;
BEGIN
  SELECT id INTO org FROM public.organizations
    WHERE slug=current_setting('test.emailsync_slug');
  IF (SELECT count(*) FROM public.organization_memberships WHERE organization_id=org)<>2 THEN
    RAISE EXCEPTION 'Invitation acceptance must have added one viewer membership';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE auth_provider='workos'
    AND auth_subject=current_setting('test.emailsync_recipient')
    AND email=current_setting('test.emailsync_next_email')
    AND email_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Recipient email sync state incorrect';
  END IF;
  IF (SELECT count(*) FROM public.audit_events WHERE organization_id=org
    AND event_type='organization.invitation.accepted')<>1 THEN
    RAISE EXCEPTION 'Exactly one acceptance audit required';
  END IF;
  IF (SELECT count(*) FROM public.organization_invitations WHERE organization_id=org
    AND consumed_at IS NOT NULL)<>1 THEN
    RAISE EXCEPTION 'Only first invitation should be consumed';
  END IF;
END;
$verify$;
SQL

echo 'PASS: real PostgreSQL email synchronization and invitation acceptance checks passed.'
