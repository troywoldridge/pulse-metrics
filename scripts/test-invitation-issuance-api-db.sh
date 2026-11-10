#!/usr/bin/env bash
# Pulse Metrics Phase 2E3B local database-backed Express test.
# Creates synthetic test organizations and users only; removes them on exit.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { echo 'ERROR: missing .env' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'ERROR: sudo required' >&2; exit 1; }
command -v node >/dev/null || { echo 'ERROR: Node required' >&2; exit 1; }

node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw) throw Error('Missing local DATABASE_URL');
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(url.hostname.toLowerCase()) ||
    decodeURIComponent(url.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(url.username) !== 'pulse_metrics_app' ||
    process.env.NODE_ENV === 'production') {
  throw Error('Refusing to run fixtures on non-local, non-development, or non-runtime database');
}
console.log('PASS: local pulse_metrics database and restricted runtime role');
NODE

PULSE_INVITE_LIVE_SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
new_uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
PULSE_INVITE_LIVE_ORG_A="$(new_uuid)"
PULSE_INVITE_LIVE_ORG_B="$(new_uuid)"
PULSE_INVITE_LIVE_OWNER_A="user_pulse_live_${PULSE_INVITE_LIVE_SUFFIX}_owner_a"
PULSE_INVITE_LIVE_ADMIN_A="user_pulse_live_${PULSE_INVITE_LIVE_SUFFIX}_admin_a"
PULSE_INVITE_LIVE_MEMBER_A="user_pulse_live_${PULSE_INVITE_LIVE_SUFFIX}_member_a"
PULSE_INVITE_LIVE_VIEWER_A="user_pulse_live_${PULSE_INVITE_LIVE_SUFFIX}_viewer_a"
PULSE_INVITE_LIVE_OWNER_B="user_pulse_live_${PULSE_INVITE_LIVE_SUFFIX}_owner_b"
PULSE_INVITE_LIVE_OUTSIDER="user_pulse_live_${PULSE_INVITE_LIVE_SUFFIX}_outsider"
PULSE_INVITE_AUDIT_FILE="$(mktemp /tmp/pulse-invite-api-audit-XXXXXX)"
chmod 600 "$PULSE_INVITE_AUDIT_FILE"
export PULSE_INVITE_LIVE_SUFFIX PULSE_INVITE_LIVE_ORG_A PULSE_INVITE_LIVE_ORG_B \
  PULSE_INVITE_LIVE_OWNER_A PULSE_INVITE_LIVE_ADMIN_A PULSE_INVITE_LIVE_MEMBER_A \
  PULSE_INVITE_LIVE_VIEWER_A PULSE_INVITE_LIVE_OWNER_B PULSE_INVITE_LIVE_OUTSIDER \
  PULSE_INVITE_AUDIT_FILE

cleanup() {
  local original=$?
  trap - EXIT
  set +e
  echo '========== CLEAN UP SYNTHETIC INVITATION API FIXTURES =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v org_a="$PULSE_INVITE_LIVE_ORG_A" -v org_b="$PULSE_INVITE_LIVE_ORG_B" \
    -v owner_a="$PULSE_INVITE_LIVE_OWNER_A" -v admin_a="$PULSE_INVITE_LIVE_ADMIN_A" \
    -v member_a="$PULSE_INVITE_LIVE_MEMBER_A" -v viewer_a="$PULSE_INVITE_LIVE_VIEWER_A" \
    -v owner_b="$PULSE_INVITE_LIVE_OWNER_B" -v outsider="$PULSE_INVITE_LIVE_OUTSIDER" <<'SQL'
BEGIN;
DELETE FROM public.organization_invitations
WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid);
DELETE FROM public.audit_events
WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid);
DELETE FROM public.organization_memberships
WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid);
DELETE FROM public.organizations
WHERE id IN (:'org_a'::uuid, :'org_b'::uuid);
DELETE FROM public.users
WHERE auth_provider = 'workos' AND auth_subject IN
 (:'owner_a', :'admin_a', :'member_a', :'viewer_a', :'owner_b', :'outsider');
COMMIT;
SQL
  local status=$?
  rm -f -- "$PULSE_INVITE_AUDIT_FILE"
  if [[ $status -ne 0 ]]; then
    echo 'ERROR: fixture cleanup failed; inspect local database' >&2
    exit 1
  fi
  echo 'PASS: synthetic fixtures and temporary audit hashes removed.'
  exit "$original"
}
trap cleanup EXIT

# Assert the live table/function still exist before installing fixtures.
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics <<'SQL'
DO $check$
BEGIN
 IF to_regclass('public.organization_invitations') IS NULL OR
    to_regprocedure('public.issue_organization_invitation(text,uuid,text,text,text,timestamp with time zone)') IS NULL THEN
   RAISE EXCEPTION 'Missing invitation schema/function. Do not modify database as part of test.';
 END IF;
END;
$check$;
SQL

echo '========== CREATE TEMPORARY TWO-ORGANIZATION FIXTURES =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v org_a="$PULSE_INVITE_LIVE_ORG_A" -v org_b="$PULSE_INVITE_LIVE_ORG_B" \
  -v suffix="$PULSE_INVITE_LIVE_SUFFIX" \
  -v owner_a="$PULSE_INVITE_LIVE_OWNER_A" -v admin_a="$PULSE_INVITE_LIVE_ADMIN_A" \
  -v member_a="$PULSE_INVITE_LIVE_MEMBER_A" -v viewer_a="$PULSE_INVITE_LIVE_VIEWER_A" \
  -v owner_b="$PULSE_INVITE_LIVE_OWNER_B" -v outsider="$PULSE_INVITE_LIVE_OUTSIDER" <<'SQL'
BEGIN;
INSERT INTO public.organizations (id,name,slug) VALUES
 (:'org_a'::uuid,'Synthetic Invitation HTTP Org A','pulse-live-a-'||:'suffix'),
 (:'org_b'::uuid,'Synthetic Invitation HTTP Org B','pulse-live-b-'||:'suffix');
INSERT INTO public.users (auth_provider,auth_subject) VALUES
 ('workos',:'owner_a'),('workos',:'admin_a'),('workos',:'member_a'),
 ('workos',:'viewer_a'),('workos',:'owner_b'),('workos',:'outsider');
INSERT INTO public.organization_memberships(organization_id,user_id,role)
SELECT o.id,u.id, v.role::public.membership_role
FROM (VALUES
 (:'org_a'::uuid,:'owner_a','owner'),
 (:'org_a'::uuid,:'admin_a','admin'),
 (:'org_a'::uuid,:'member_a','member'),
 (:'org_a'::uuid,:'viewer_a','viewer'),
 (:'org_b'::uuid,:'owner_b','owner')
) AS v(org,subject,role)
JOIN public.organizations o ON o.id=v.org
JOIN public.users u ON u.auth_provider='workos' AND u.auth_subject=v.subject;
COMMIT;
SQL

echo '========== REAL EXPRESS ROUTE + DATABASE SERVICE TESTS =========='
DATABASE_POOL_MAX=1 npx tsx --test tests/integration/invitation-issuance.integration.test.ts

echo '========== STORED HASH VERIFICATION =========='
expected=0
while read -r invitation_id token_digest; do
  [[ "$invitation_id" =~ ^[0-9a-f-]{36}$ ]] || { echo 'ERROR: bad audit invitation id' >&2; exit 1; }
  [[ "$token_digest" =~ ^[a-f0-9]{64}$ ]] || { echo 'ERROR: bad audit digest' >&2; exit 1; }
  verified="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -At -d pulse_metrics \
    -v invitation_id="$invitation_id" -v token_digest="$token_digest" \
    -v org_a="$PULSE_INVITE_LIVE_ORG_A" -v org_b="$PULSE_INVITE_LIVE_ORG_B" <<'SQL'
SELECT count(*) FROM public.organization_invitations
WHERE id = :'invitation_id'::uuid AND token_hash = :'token_digest'
  AND organization_id IN (:'org_a'::uuid, :'org_b'::uuid);
SQL
  )"
  [[ "$verified" == '1' ]] || { echo 'ERROR: invitation hash mismatch' >&2; exit 1; }
  expected=$((expected+1))
done < "$PULSE_INVITE_AUDIT_FILE"
[[ "$expected" == 4 ]] || { echo "ERROR: expected 4 invitations, got $expected" >&2; exit 1; }

read -r invitations audits membership_count <<< "$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -At -F ' ' -d pulse_metrics \
  -v org_a="$PULSE_INVITE_LIVE_ORG_A" -v org_b="$PULSE_INVITE_LIVE_ORG_B" <<'SQL'
SELECT
 (SELECT count(*) FROM public.organization_invitations
  WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid)),
 (SELECT count(*) FROM public.audit_events
  WHERE event_type='organization.invitation.created'
    AND organization_id IN (:'org_a'::uuid, :'org_b'::uuid)),
 (SELECT count(*) FROM public.organization_memberships
  WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid));
SQL
)"
[[ "$invitations" == 4 && "$audits" == 4 && "$membership_count" == 5 ]] || {
  echo "ERROR: unexpected counts: invitations=$invitations audits=$audits memberships=$membership_count" >&2
  exit 1
}
echo 'PASS: four distinct invitation hashes match the returned secrets.'
echo 'PASS: four creation audit events exist and five fixture memberships remain unchanged.'
echo 'PASS: database-backed invitation issuance HTTP verification complete.'
