#!/usr/bin/env bash
# LOCAL DEV ONLY. Real Express + PostgreSQL, synthetic WorkOS profiles.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: .env required for local database' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo required' >&2; exit 1; }

node --env-file=.env --input-type=module <<'NODE'
const value=process.env.DATABASE_URL;
if (!value) throw Error('Missing local DATABASE_URL');
const u=new URL(value);
if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['127.0.0.1','localhost','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1))!=='pulse_metrics' ||
    decodeURIComponent(u.username)!=='pulse_metrics_app' ||
    process.env.NODE_ENV==='production') {
  throw Error('Refusing test fixtures on nonlocal/non-runtime/production database');
}
console.log('PASS: local pulse_metrics database and restricted runtime role');
NODE

SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
SUBJECT_OWNER_A="user_http_redeem_${SUFFIX}_oa"
SUBJECT_OWNER_B="user_http_redeem_${SUFFIX}_ob"
SUBJECT_RECIPIENT_A="user_http_redeem_${SUFFIX}_ra"
SUBJECT_RECIPIENT_B="user_http_redeem_${SUFFIX}_rb"
SUBJECT_OUTSIDER="user_http_redeem_${SUFFIX}_outsider"
SLUG_A="pulse-http-redeem-a-${SUFFIX}"
SLUG_B="pulse-http-redeem-b-${SUFFIX}"
export SUFFIX SUBJECT_OWNER_A SUBJECT_OWNER_B SUBJECT_RECIPIENT_A SUBJECT_RECIPIENT_B SUBJECT_OUTSIDER

cleanup() {
  local initial=$?
  trap - EXIT
  set +e
  echo '========== CLEAN UP SYNTHETIC HTTP FIXTURES =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" \
    -v owner_a="$SUBJECT_OWNER_A" -v owner_b="$SUBJECT_OWNER_B" \
    -v recipient_a="$SUBJECT_RECIPIENT_A" -v recipient_b="$SUBJECT_RECIPIENT_B" \
    -v outsider="$SUBJECT_OUTSIDER" <<'SQL'
BEGIN;
DELETE FROM public.organization_invitations WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b'));
DELETE FROM public.audit_events WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b'));
DELETE FROM public.organization_memberships WHERE organization_id IN
  (SELECT id FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b'));
DELETE FROM public.organizations WHERE slug IN (:'slug_a',:'slug_b');
DELETE FROM public.users WHERE auth_provider='workos' AND auth_subject IN
  (:'owner_a',:'owner_b',:'recipient_a',:'recipient_b',:'outsider');
COMMIT;
SQL
  local removed=$?
  if [[ "$removed" -ne 0 ]]; then
    echo 'ERROR: fixture cleanup failed; inspect local PostgreSQL' >&2
    exit 1
  fi
  echo 'PASS: synthetic HTTP fixtures removed'
  exit "$initial"
}
trap cleanup EXIT

echo '========== CREATE TWO TEMPORARY ORGANIZATIONS AND USERS =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" \
  -v owner_a="$SUBJECT_OWNER_A" -v owner_b="$SUBJECT_OWNER_B" \
  -v recipient_a="$SUBJECT_RECIPIENT_A" -v recipient_b="$SUBJECT_RECIPIENT_B" \
  -v outsider="$SUBJECT_OUTSIDER" <<'SQL'
BEGIN;
INSERT INTO public.users(auth_provider,auth_subject) VALUES
  ('workos',:'owner_a'),('workos',:'owner_b'),
  ('workos',:'recipient_a'),('workos',:'recipient_b'),('workos',:'outsider');
INSERT INTO public.organizations(name,slug) VALUES
  ('Synthetic HTTP Acceptance Org A',:'slug_a'),
  ('Synthetic HTTP Acceptance Org B',:'slug_b');
INSERT INTO public.organization_memberships(organization_id,user_id,role)
SELECT o.id,u.id,'owner'::public.membership_role
FROM (VALUES (:'slug_a',:'owner_a'),(:'slug_b',:'owner_b')) v(slug,subject)
JOIN public.organizations o ON o.slug=v.slug
JOIN public.users u ON u.auth_provider='workos' AND u.auth_subject=v.subject;
COMMIT;
SQL
mapfile -t ORG_IDS < <(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics \
  -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" <<'SQL'
SELECT id FROM public.organizations WHERE slug=:'slug_a';
SELECT id FROM public.organizations WHERE slug=:'slug_b';
SQL
)
[[ "${#ORG_IDS[@]}" -eq 2 ]] || { echo 'ERROR: missing fixture orgs' >&2; exit 1; }
ORG_A="${ORG_IDS[0]}"
ORG_B="${ORG_IDS[1]}"
[[ "$ORG_A" =~ ^[0-9a-f-]{36}$ && "$ORG_B" =~ ^[0-9a-f-]{36}$ ]] || {
  echo 'ERROR: invalid fixture organization IDs' >&2; exit 1;
}
export ORG_A ORG_B

echo '========== REAL EXPRESS + POSTGRESQL INTEGRATION =========='
node --env-file=.env --import tsx --test tests/integration/invitation-acceptance-http-db.integration.test.ts

echo '========== VERIFY MEMBERSHIPS, INVITATIONS AND AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug_a="$SLUG_A" -v slug_b="$SLUG_B" \
  -v email_a="recipient-a.${SUFFIX}@example.invalid" \
  -v email_b="recipient-b.${SUFFIX}@example.invalid" \
  -v recipient_a="$SUBJECT_RECIPIENT_A" -v recipient_b="$SUBJECT_RECIPIENT_B" \
  -v outsider="$SUBJECT_OUTSIDER" <<'SQL'
SELECT set_config('test.slug_a',:'slug_a',false),
       set_config('test.slug_b',:'slug_b',false),
       set_config('test.email_a',:'email_a',false),
       set_config('test.email_b',:'email_b',false),
       set_config('test.recipient_a',:'recipient_a',false),
       set_config('test.recipient_b',:'recipient_b',false),
       set_config('test.outsider',:'outsider',false);
DO $verify$
DECLARE
  org_a uuid;
  org_b uuid;
BEGIN
  SELECT id INTO org_a FROM public.organizations WHERE slug=current_setting('test.slug_a');
  SELECT id INTO org_b FROM public.organizations WHERE slug=current_setting('test.slug_b');
  IF org_a IS NULL OR org_b IS NULL THEN RAISE EXCEPTION 'Missing org fixtures'; END IF;
  IF (SELECT count(*) FROM public.organization_invitations WHERE organization_id IN (org_a,org_b))<>3
     OR (SELECT count(*) FROM public.organization_invitations WHERE organization_id IN (org_a,org_b)
          AND consumed_at IS NOT NULL)<>2 THEN
    RAISE EXCEPTION 'Invitation count or consumption mismatch';
  END IF;
  IF (SELECT count(*) FROM public.audit_events WHERE organization_id IN (org_a,org_b)
        AND event_type='organization.invitation.accepted')<>2 THEN
    RAISE EXCEPTION 'Expected two acceptance audit events';
  END IF;
  IF (SELECT count(*) FROM public.organization_memberships WHERE organization_id IN (org_a,org_b))<>4 THEN
    RAISE EXCEPTION 'Unexpected memberships';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_memberships m JOIN public.users u ON u.id=m.user_id
    WHERE m.organization_id=org_a AND m.role='viewer' AND u.auth_subject=current_setting('test.recipient_a'))
    OR NOT EXISTS (SELECT 1 FROM public.organization_memberships m JOIN public.users u ON u.id=m.user_id
    WHERE m.organization_id=org_b AND m.role='viewer' AND u.auth_subject=current_setting('test.recipient_b'))
    OR EXISTS (SELECT 1 FROM public.organization_memberships m JOIN public.users u ON u.id=m.user_id
    WHERE m.organization_id IN (org_a,org_b) AND u.auth_subject=current_setting('test.outsider')) THEN
    RAISE EXCEPTION 'Wrong organization or recipient role, or outsider membership';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE auth_subject=current_setting('test.recipient_a')
    AND email=current_setting('test.email_a') AND email_verified_at IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM public.users WHERE auth_subject=current_setting('test.recipient_b')
    AND email=current_setting('test.email_b') AND email_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Verified email states incorrect after acceptance';
  END IF;
END;
$verify$;
SQL

echo 'PASS: full local synthetic HTTP-to-PostgreSQL acceptance checks passed'
