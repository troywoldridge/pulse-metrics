#!/usr/bin/env bash
# Phase 2E2 — local-only real PostgreSQL/Express membership authorization test.
# Temporary fixture data is deleted on success and failure.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then echo 'ERROR: Missing .env' >&2; exit 1; fi
if ! command -v sudo >/dev/null 2>&1; then echo 'ERROR: sudo is required' >&2; exit 1; fi

node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw) throw Error('DATABASE_URL missing');
const url = new URL(raw);
const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
const username = decodeURIComponent(url.username);
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase()) ||
    name !== 'pulse_metrics' || username !== 'pulse_metrics_app' ||
    process.env.NODE_ENV === 'production') {
  throw Error('Refusing tests: not a safe local development database/runtime role');
}
console.log('PASS: Safe local pulse_metrics DB and restricted application role');
NODE

new_uuid() { if [[ -r /proc/sys/kernel/random/uuid ]]; then cat /proc/sys/kernel/random/uuid; else uuidgen; fi; }
PULSE_ROSTER_TEST_ORG_A="$(new_uuid)"
PULSE_ROSTER_TEST_ORG_B="$(new_uuid)"
suffix="${PULSE_ROSTER_TEST_ORG_A:0:8}"

roles=(owner_a admin_a member_a viewer_a owner_b admin_b member_b viewer_b outsider)
for role in "${roles[@]}"; do
  declare "id_${role}=$(new_uuid)"
  declare "subject_${role}=user_pulse_roster_${suffix}_${role}"
done

cleanup() {
  local original_status=$?
  trap - EXIT
  set +e
  echo '========== CLEAN UP MEMBERSHIP TEST FIXTURES =========='
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
    -v org_a="$PULSE_ROSTER_TEST_ORG_A" -v org_b="$PULSE_ROSTER_TEST_ORG_B" \
    -v id_owner_a="$id_owner_a" -v id_admin_a="$id_admin_a" \
    -v id_member_a="$id_member_a" -v id_viewer_a="$id_viewer_a" \
    -v id_owner_b="$id_owner_b" -v id_admin_b="$id_admin_b" \
    -v id_member_b="$id_member_b" -v id_viewer_b="$id_viewer_b" \
    -v id_outsider="$id_outsider" <<'SQL'
BEGIN;
DELETE FROM public.organization_memberships
WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid);
DELETE FROM public.organizations
WHERE id IN (:'org_a'::uuid, :'org_b'::uuid);
DELETE FROM public.users
WHERE id IN (
  :'id_owner_a'::uuid, :'id_admin_a'::uuid,
  :'id_member_a'::uuid, :'id_viewer_a'::uuid,
  :'id_owner_b'::uuid, :'id_admin_b'::uuid,
  :'id_member_b'::uuid, :'id_viewer_b'::uuid,
  :'id_outsider'::uuid
);
COMMIT;
SQL
  local cleanup_status=$?
  if [[ "$cleanup_status" -ne 0 ]]; then
    echo 'ERROR: Fixture cleanup failed. Inspect local test database.' >&2
    exit 1
  fi
  echo 'PASS: Temporary membership fixtures cleaned up.'
  exit "$original_status"
}
trap cleanup EXIT

echo '========== CREATE TEMPORARY TWO-ORGANIZATION ROLE FIXTURES =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics \
  -v org_a="$PULSE_ROSTER_TEST_ORG_A" -v org_b="$PULSE_ROSTER_TEST_ORG_B" \
  -v suffix="$suffix" \
  -v id_owner_a="$id_owner_a" -v id_admin_a="$id_admin_a" \
  -v id_member_a="$id_member_a" -v id_viewer_a="$id_viewer_a" \
  -v id_owner_b="$id_owner_b" -v id_admin_b="$id_admin_b" \
  -v id_member_b="$id_member_b" -v id_viewer_b="$id_viewer_b" \
  -v id_outsider="$id_outsider" \
  -v subject_owner_a="$subject_owner_a" -v subject_admin_a="$subject_admin_a" \
  -v subject_member_a="$subject_member_a" -v subject_viewer_a="$subject_viewer_a" \
  -v subject_owner_b="$subject_owner_b" -v subject_admin_b="$subject_admin_b" \
  -v subject_member_b="$subject_member_b" -v subject_viewer_b="$subject_viewer_b" \
  -v subject_outsider="$subject_outsider" <<'SQL'
BEGIN;
INSERT INTO public.organizations (id, name, slug) VALUES
  (:'org_a'::uuid, 'Membership Test Organization A', 'pulse-roster-a-' || :'suffix'),
  (:'org_b'::uuid, 'Membership Test Organization B', 'pulse-roster-b-' || :'suffix');
INSERT INTO public.users (id, auth_provider, auth_subject) VALUES
  (:'id_owner_a'::uuid, 'workos', :'subject_owner_a'),
  (:'id_admin_a'::uuid, 'workos', :'subject_admin_a'),
  (:'id_member_a'::uuid, 'workos', :'subject_member_a'),
  (:'id_viewer_a'::uuid, 'workos', :'subject_viewer_a'),
  (:'id_owner_b'::uuid, 'workos', :'subject_owner_b'),
  (:'id_admin_b'::uuid, 'workos', :'subject_admin_b'),
  (:'id_member_b'::uuid, 'workos', :'subject_member_b'),
  (:'id_viewer_b'::uuid, 'workos', :'subject_viewer_b'),
  (:'id_outsider'::uuid, 'workos', :'subject_outsider');
INSERT INTO public.organization_memberships
(organization_id, user_id, role, display_name) VALUES
  (:'org_a'::uuid, :'id_owner_a'::uuid, 'owner', 'Fixture Owner A'),
  (:'org_a'::uuid, :'id_admin_a'::uuid, 'admin', 'Fixture Admin A'),
  (:'org_a'::uuid, :'id_member_a'::uuid, 'member', 'Fixture Member A'),
  (:'org_a'::uuid, :'id_viewer_a'::uuid, 'viewer', 'Fixture Viewer A'),
  (:'org_b'::uuid, :'id_owner_b'::uuid, 'owner', 'Fixture Owner B'),
  (:'org_b'::uuid, :'id_admin_b'::uuid, 'admin', 'Fixture Admin B'),
  (:'org_b'::uuid, :'id_member_b'::uuid, 'member', 'Fixture Member B'),
  (:'org_b'::uuid, :'id_viewer_b'::uuid, 'viewer', 'Fixture Viewer B');
COMMIT;
SQL

export PULSE_ROSTER_TEST_ORG_A PULSE_ROSTER_TEST_ORG_B
export PULSE_ROSTER_TEST_OWNER_A="$subject_owner_a"
export PULSE_ROSTER_TEST_ADMIN_A="$subject_admin_a"
export PULSE_ROSTER_TEST_MEMBER_A="$subject_member_a"
export PULSE_ROSTER_TEST_VIEWER_A="$subject_viewer_a"
export PULSE_ROSTER_TEST_OWNER_B="$subject_owner_b"
export PULSE_ROSTER_TEST_ADMIN_B="$subject_admin_b"
export PULSE_ROSTER_TEST_MEMBER_B="$subject_member_b"
export PULSE_ROSTER_TEST_VIEWER_B="$subject_viewer_b"
export PULSE_ROSTER_TEST_OUTSIDER="$subject_outsider"

echo '========== LIVE EXPRESS + POSTGRESQL AUTHORIZATION TESTS =========='
DATABASE_POOL_MAX=1 npx tsx --test tests/integration/membership-roster.integration.test.ts

echo 'PASS: PostgreSQL-backed membership role and tenant tests passed.'
