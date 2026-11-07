#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

DATABASE_NAME="pulse_metrics"
RUNTIME_ROLE="pulse_metrics_app"

if [[ ! -f .env ]]; then
  echo "ERROR: .env was not found. The integration test requires the local runtime configuration."
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "ERROR: sudo is required for local PostgreSQL fixture administration."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx was not found. Install the project dependencies first."
  exit 1
fi

echo
echo "========== DATABASE SAFETY CHECK =========="

node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;

if (!raw) {
  console.error("ERROR: DATABASE_URL is missing.");
  process.exit(1);
}

let url;

try {
  url = new URL(raw);
} catch {
  console.error("ERROR: DATABASE_URL is not a valid URL.");
  process.exit(1);
}

const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
const username = decodeURIComponent(url.username);
const hostname = url.hostname.toLowerCase();
const production = process.env.NODE_ENV === "production";

console.log("Database:", database);
console.log("Runtime role:", username);
console.log("Host:", hostname);
console.log("Production mode:", production);

if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  database !== "pulse_metrics" ||
  username !== "pulse_metrics_app" ||
  !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
  production
) {
  console.error("ERROR: Database safety check failed. No fixtures were created.");
  process.exit(1);
}

console.log("PASS: Local test database and restricted runtime role verified.");
NODE

echo
echo "========== VERIFY POSTGRESQL ADMIN ACCESS =========="

sudo -u postgres psql \
  -X \
  -v ON_ERROR_STOP=1 \
  -d "$DATABASE_NAME" \
  -P pager=off \
  -c "SELECT current_database(), current_user;"

new_uuid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  else
    uuidgen
  fi
}

validate_uuid() {
  local value="$1"

  if [[ ! "$value" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    echo "ERROR: Generated fixture identifier is not a valid UUID."
    exit 1
  fi
}

ORG_A="$(new_uuid)"
ORG_B="$(new_uuid)"
USER_A="$(new_uuid)"
USER_B="$(new_uuid)"
AGENT_A="$(new_uuid)"
AGENT_B="$(new_uuid)"

for value in "$ORG_A" "$ORG_B" "$USER_A" "$USER_B" "$AGENT_A" "$AGENT_B"; do
  validate_uuid "$value"
done

SUFFIX="${ORG_A:0:8}"

export TENANT_TEST_ORGANIZATION_A_ID="$ORG_A"
export TENANT_TEST_ORGANIZATION_B_ID="$ORG_B"
export TENANT_TEST_USER_A_ID="$USER_A"
export TENANT_TEST_USER_B_ID="$USER_B"

cleanup() {
  local original_status=$?
  local cleanup_status=0

  trap - EXIT
  set +e

  echo
  echo "========== CLEAN UP TEMPORARY TEST FIXTURES =========="

  sudo -u postgres psql \
    -X \
    -v ON_ERROR_STOP=1 \
    -d "$DATABASE_NAME" \
    -v org_a="$ORG_A" \
    -v org_b="$ORG_B" \
    -v user_a="$USER_A" \
    -v user_b="$USER_B" \
    -P pager=off <<'SQL'
BEGIN;

DELETE FROM telemetry_samples
WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid);

DELETE FROM monitored_agents
WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid);

DELETE FROM organization_memberships
WHERE organization_id IN (:'org_a'::uuid, :'org_b'::uuid)
   OR user_id IN (:'user_a'::uuid, :'user_b'::uuid);

DELETE FROM organizations
WHERE id IN (:'org_a'::uuid, :'org_b'::uuid);

DELETE FROM users
WHERE id IN (:'user_a'::uuid, :'user_b'::uuid);

COMMIT;
SQL

  cleanup_status=$?

  if [[ "$cleanup_status" -eq 0 ]]; then
    echo "PASS: Temporary organizations, users, memberships, agents and telemetry removed."
  else
    echo "ERROR: Fixture cleanup failed. Inspect the database before running the test again."
  fi

  if [[ "$original_status" -ne 0 ]]; then
    exit "$original_status"
  fi

  if [[ "$cleanup_status" -ne 0 ]]; then
    exit 1
  fi

  exit 0
}

trap cleanup EXIT

echo
echo "========== CREATE TEMPORARY TENANT FIXTURES =========="

sudo -u postgres psql \
  -X \
  -v ON_ERROR_STOP=1 \
  -d "$DATABASE_NAME" \
  -v org_a="$ORG_A" \
  -v org_b="$ORG_B" \
  -v user_a="$USER_A" \
  -v user_b="$USER_B" \
  -v agent_a="$AGENT_A" \
  -v agent_b="$AGENT_B" \
  -v suffix="$SUFFIX" \
  -P pager=off <<'SQL'
BEGIN;

INSERT INTO organizations (id, name, slug)
VALUES
  (
    :'org_a'::uuid,
    'Pulse Metrics Integration Test A',
    'pulse-test-a-' || :'suffix'
  ),
  (
    :'org_b'::uuid,
    'Pulse Metrics Integration Test B',
    'pulse-test-b-' || :'suffix'
  );

INSERT INTO users (id, auth_provider, auth_subject, display_name)
VALUES
  (
    :'user_a'::uuid,
    'integration-test',
    'pulse-test-' || :'suffix' || '-user-a',
    'Integration Test User A'
  ),
  (
    :'user_b'::uuid,
    'integration-test',
    'pulse-test-' || :'suffix' || '-user-b',
    'Integration Test User B'
  );

INSERT INTO organization_memberships
  (organization_id, user_id, display_name)
VALUES
  (
    :'org_a'::uuid,
    :'user_a'::uuid,
    'Integration Test Member A'
  ),
  (
    :'org_b'::uuid,
    :'user_b'::uuid,
    'Integration Test Member B'
  );

INSERT INTO monitored_agents
  (id, organization_id, display_name, hostname, platform, architecture)
VALUES
  (
    :'agent_a'::uuid,
    :'org_a'::uuid,
    'Isolation Test Agent A',
    'integration-test-a.local',
    'linux',
    'x86_64'
  ),
  (
    :'agent_b'::uuid,
    :'org_b'::uuid,
    'Isolation Test Agent B',
    'integration-test-b.local',
    'linux',
    'x86_64'
  );

INSERT INTO telemetry_samples
  (organization_id, agent_id, recorded_at, metrics)
VALUES
  (
    :'org_a'::uuid,
    :'agent_a'::uuid,
    now(),
    '{"test":"organization-a"}'::jsonb
  ),
  (
    :'org_b'::uuid,
    :'agent_b'::uuid,
    now(),
    '{"test":"organization-b"}'::jsonb
  );

COMMIT;
SQL

echo
echo "PASS: Two isolated organizations and their test records were created."

echo
echo "========== TENANT ISOLATION TEST: INITIAL MEMBERSHIPS =========="

DATABASE_POOL_MAX=1 \
TENANT_TEST_PHASE=initial \
npx tsx --test tests/integration/tenant-context.integration.test.ts

echo
echo "========== REVOKE ORGANIZATION A MEMBERSHIP =========="

sudo -u postgres psql \
  -X \
  -v ON_ERROR_STOP=1 \
  -d "$DATABASE_NAME" \
  -v org_a="$ORG_A" \
  -v user_a="$USER_A" \
  -P pager=off <<'SQL'
DELETE FROM organization_memberships
WHERE organization_id = :'org_a'::uuid
  AND user_id = :'user_a'::uuid;

SELECT
  NOT EXISTS (
    SELECT 1
    FROM organization_memberships
    WHERE organization_id = :'org_a'::uuid
      AND user_id = :'user_a'::uuid
  ) AS organization_a_membership_revoked;
SQL

echo
echo "========== TENANT ISOLATION TEST: REVOKED MEMBERSHIP =========="

DATABASE_POOL_MAX=1 \
TENANT_TEST_PHASE=revoked \
npx tsx --test tests/integration/tenant-context.integration.test.ts

echo
echo "PASS: Both integration test phases completed."
echo "Temporary fixtures will now be removed."
