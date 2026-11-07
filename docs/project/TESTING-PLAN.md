# Pulse Metrics — Testing Plan

**Document status:** Active
**Last reviewed:** 2026-11-07

## 1. Testing principles

- Test security boundaries, not only successful workflows.
- Prefer real PostgreSQL tests for database security.
- Use the restricted application database role for application operations.
- Keep test data isolated, temporary and identifiable.
- Attempt cleanup after successful and failed test execution.
- Never use production customer data as test fixtures.
- Record actual commands and results.
- A passing test only proves the behavior covered by that test.
- Local test success does not establish production readiness.

## 2. Test categories

### Unit tests

Test isolated application logic such as calculations, validation and anomaly detection.

Existing unit test files:

- `src/utils/anomaly-detector.test.ts`
- `src/utils/metrics-calculator.test.ts`

Run with:

```bash
npm test
```

### Database integration tests

Use real PostgreSQL to verify:

- Schema constraints and foreign keys.
- Database role permissions.
- Row-level security.
- Tenant context and membership verification.
- Transaction behavior and pooled connection reuse.
- Fixture setup and cleanup.

### API integration tests — future work

- Authentication and authorization.
- Organization membership and roles.
- Agent enrollment and credential verification.
- Telemetry validation and ingestion.
- Rate limiting and error handling.
- Audit-event generation.

### Agent tests — future work

- Actual system measurements.
- Permission and platform handling.
- Network failure and reconnection.
- Authentication and credential rotation.
- Invalid or unavailable measurements.
- Resource consumption.

### End-to-end tests — future work

Cover customer workflows from account creation through organization setup, agent enrollment, telemetry display and billing.

## 3. Repeatable tenant-isolation integration test

**Command:**

```bash
npm run test:integration
```

**Implementation:**

- Fixture setup: `scripts/test-tenant-isolation.sh`
- Integration test: `tests/integration/tenant-context.integration.test.ts`

The test targets the local PostgreSQL database `pulse_metrics`.

Before creating fixtures, the setup script verifies:

- Database name is `pulse_metrics`.
- Runtime role is `pulse_metrics_app`.
- Database host is a loopback address.
- Production mode is disabled.
- Administrative PostgreSQL access is available.

The script creates temporary records for two independent organizations:

- Two organizations.
- Two users.
- Two memberships.
- Two monitored agents.
- Two telemetry samples.

Administrative database access is used for fixture setup, membership revocation and cleanup. Application-path tests use the restricted `pulse_metrics_app` role.

The script generates unique UUIDs for each run. An exit trap attempts to remove temporary telemetry, agents, memberships, organizations and users after successful or failed execution.

The integration tests use a single-connection database pool to exercise transaction-local tenant context and connection reuse.

### Initial-membership coverage

- [x] Runtime connection uses `pulse_metrics_app`.
- [x] Malformed organization UUIDs are rejected.
- [x] Malformed user UUIDs are rejected.
- [x] Nonexistent users are denied.
- [x] Nonexistent organizations are denied.
- [x] User A reads Organization A agent data.
- [x] User A reads Organization A telemetry.
- [x] User A is denied Organization B.
- [x] User B reads Organization B agent data.
- [x] User B reads Organization B telemetry.
- [x] Unscoped agent queries return no tenant rows.
- [x] Unscoped telemetry queries return no tenant rows.
- [x] Transaction-local tenant context is cleared after completion.
- [x] Reusing the database connection does not retain the previous tenant context.

### Revoked-membership coverage

- [x] Organization A membership is deleted.
- [x] User A is denied Organization A after revocation.
- [x] User B retains access to Organization B.

### Running the test

Run from the repository root:

```bash
npm run test:integration
```

The command creates its own fixtures. Do not manually seed test records first.

Do not weaken the database safety checks to run this script against another environment.

### Cleanup verification

After the integration test, verify that no fixtures remain:

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics -P pager=off <<'SQL'
SELECT
    (SELECT count(*) FROM organizations
     WHERE slug LIKE 'pulse-test-a-%'
        OR slug LIKE 'pulse-test-b-%') AS test_organizations,
    (SELECT count(*) FROM users
     WHERE auth_provider = 'integration-test') AS test_users,
    (SELECT count(*) FROM monitored_agents
     WHERE hostname LIKE 'integration-test-%') AS test_agents,
    (SELECT count(*) FROM telemetry_samples t
     JOIN monitored_agents a ON a.id = t.agent_id
     WHERE a.hostname LIKE 'integration-test-%') AS test_telemetry;
SQL
```

All four counts should be zero.

## 4. Standard verification commands

```bash
npm test
npm run lint
npm run build
npm run db:check
npm run test:integration
```

Do not claim a check passed unless its command completed successfully. A check that has not been run remains unverified.

## 5. Test results — 2026-11-07

**Environment:** Local Ubuntu development machine and PostgreSQL database `pulse_metrics`.

**Runtime role:** `pulse_metrics_app`.

The repeatable integration command was run twice.

| Phase | Tests per run | Passed | Failed |
|---|---:|---:|---:|
| Initial memberships | 1 | 1 | 0 |
| Revoked membership | 1 | 1 | 0 |
| Total | 2 | 2 | 0 |

Both runs completed successfully.

The cleanup routine completed after both runs. A separate PostgreSQL query confirmed:

| Fixture type | Remaining |
|---|---:|
| Test organizations | 0 |
| Test users | 0 |
| Test agents | 0 |
| Test telemetry | 0 |

### Supporting verification

| Command | Result |
|---|---|
| `npm run lint` | Passed |
| `npm test` | 13 passed, 0 failed |
| `npm run db:check` | Passed |
| `npm run test:integration` | Passed twice |

`npm run build` was not included in this verification run and is not recorded as passed.

An earlier manual integration test used manually prepared fixtures. It has been superseded by the repeatable workflow described above.

## 6. Recording future results

Record the date, command, environment, number of tests passed and failed, relevant failures and follow-up work.

Never include passwords, tokens, connection strings or customer secrets.

## 7. Testing limitations

These tests cover the tenant-context helper and selected PostgreSQL row-level security scenarios. They do not prove that every possible tenant-isolation attack path has been covered.

Further testing is required for authenticated API authorization, concurrent requests, agent enrollment, credential lifecycle, telemetry authorization, organization administration, penetration testing, production configuration and backup recovery.