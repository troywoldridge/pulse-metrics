#!/usr/bin/env bash
# Local-only transaction test. Synthetic users/organizations/invitations only.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: local .env is required' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo is required' >&2; exit 1; }

node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw) throw Error('Missing local DATABASE_URL');
const u = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(u.username) !== 'pulse_metrics_app' ||
    process.env.NODE_ENV === 'production') {
  throw Error('Refusing fixture operations against an unsafe database');
}
console.log('PASS: local database target and restricted runtime role');
NODE

SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
SUBJECT_OWNER="user_pulse_redeem_${SUFFIX}_owner"
SUBJECT_RECIPIENT="user_pulse_redeem_${SUFFIX}_recipient"
SUBJECT_OTHER="user_pulse_redeem_${SUFFIX}_other"
SLUG="pulse-redeem-${SUFFIX}"
export SUFFIX SUBJECT_OWNER SUBJECT_RECIPIENT SUBJECT_OTHER

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  echo '========== CLEAN UP SYNTHETIC ACCEPTANCE FIXTURES =========='
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
  (:'owner',:'recipient',:'other');
COMMIT;
SQL
  local removed=$?
  if [[ "$removed" -ne 0 ]]; then
    echo 'ERROR: cleanup failed; inspect synthetic fixtures' >&2
    exit 1
  fi
  echo 'PASS: synthetic fixtures removed'
  exit "$status"
}
trap cleanup EXIT

echo '========== CREATE SYNTHETIC USERS AND ORGANIZATION =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v slug="$SLUG" -v owner="$SUBJECT_OWNER" \
  -v recipient="$SUBJECT_RECIPIENT" -v other="$SUBJECT_OTHER" <<'SQL'
BEGIN;
INSERT INTO public.users(auth_provider,auth_subject) VALUES
  ('workos',:'owner'),('workos',:'recipient'),('workos',:'other');
INSERT INTO public.organizations(name,slug) VALUES
  ('Synthetic Transaction Redemption Test',:'slug');
INSERT INTO public.organization_memberships(organization_id,user_id,role)
SELECT o.id,u.id,'owner'::public.membership_role FROM public.organizations o
JOIN public.users u ON u.auth_provider='workos' AND u.auth_subject=:'owner'
WHERE o.slug=:'slug';
COMMIT;
SQL
ORG_ID="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics -v slug="$SLUG" <<'SQL'
SELECT id FROM public.organizations WHERE slug=:'slug';
SQL
)"
[[ "$ORG_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo 'ERROR: could not resolve fixture organization' >&2; exit 1; }
export ORG_ID

echo '========== REAL POSTGRESQL TRANSACTION TEST =========='
node --env-file=.env --import tsx --test tests/integration/invitation-acceptance-transaction.integration.test.ts

echo '========== VERIFY EXPECTED INVITATIONS, MEMBERSHIPS AND AUDIT =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics -v slug="$SLUG" <<'SQL'
SELECT set_config('test.redemption_slug',:'slug',false);
DO $verify$
DECLARE org uuid;
BEGIN
  SELECT id INTO org FROM public.organizations WHERE slug=current_setting('test.redemption_slug');
  IF org IS NULL THEN RAISE EXCEPTION 'Missing synthetic organization'; END IF;
  IF (SELECT count(*) FROM public.organization_memberships WHERE organization_id=org) <> 3 THEN
    RAISE EXCEPTION 'Expected owner + two accepted members';
  END IF;
  IF (SELECT count(*) FROM public.organization_invitations WHERE organization_id=org) <> 3 THEN
    RAISE EXCEPTION 'Expected three synthetic invitations';
  END IF;
  IF (SELECT count(*) FROM public.organization_invitations WHERE organization_id=org AND consumed_at IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'Exactly two invitations should be consumed';
  END IF;
  IF (SELECT count(*) FROM public.audit_events WHERE organization_id=org AND event_type='organization.invitation.accepted') <> 2 THEN
    RAISE EXCEPTION 'Exactly two acceptance audit events required';
  END IF;
END;
$verify$;
SQL
echo 'PASS: transactional email synchronization and invitation acceptance verified'
