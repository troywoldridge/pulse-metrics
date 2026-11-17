# Pulse Metrics — D15C-5U-2F2K: Disposable one-tenant identity rehearsal

**Status:** Offline source candidate. The actual PostgreSQL exercise has **not** run on Troy's machine.

**Public launch:** NO_GO. A synthetic identity test never authorizes agent enrollment, customer data admission, credential issuance, a signing authority, or persistent telemetry writes.

## Why 2F2K is separate

- The reviewed D15C-4B (`scripts/test-telemetry-agent-quota-http-rehearsal.sh`) runs a fully disposable PostgreSQL 16 cluster on a private `/tmp/pulse-replay-XXXXXXXXXX/socket` at port `55432`, then creates **two organizations** and durable telemetry for a regression test.
- The verified 2F2J SQL requires **exactly one synthetic owner, one organization, one membership, one active agent, one active credential and zero telemetry samples/submissions**.
- Instead of modifying that reviewed script or using protected development PostgreSQL on `55433`, 2F2K creates a **complete, temporary generated rehearsal** containing only the pinned original prefix before two-tenant fixture creation, plus a pinned one-tenant stage. The original file stays byte-identical.

## New complete source files

- `scripts/telemetry-persistent/run-disposable-one-tenant-identity.sh`: exact source fingerprints, Git baseline check, fail-closed CLI, separate opt-in, creation/validation of generated complete temporary script, mandatory test cleanup evidence.
- `scripts/telemetry-persistent/disposable-one-tenant-identity-stage.sh`: embedded in the generated temporary full script. Installs reviewed D15C-4E authentication-outcome revision on disposable database, invokes 2F2J SQL through its **unchanged** pinned read-only operator, tests owner downgrade, agent revoke, credential revoke, and extra-user denials, then checks restored positive state.
- `scripts/telemetry-persistent/disposable-one-tenant-identity-fixture.sql`: SQL guarded by exact PostgreSQL 16 database, data-directory path, socket, `55432`, migration receipts and privilege checks. Creates synthetic owner/organization and one directly seeded agent/credential. **No redeemable token is stored or issued**; the credential digest comes from a discarded random value. No telemetry is inserted.
- `scripts/telemetry-persistent/disposable-one-tenant-identity.test.mjs`: standalone offline security regressions, including generated complete source composition validation when the pinned original is present.
- `README-D15C-5U-2F2K.md`: this deployment boundary and instructions.

No existing files, migration tables, PostgreSQL credentials, .env files, protected recovery data, service configuration, production routes, or existing two-tenant rehearsal scripts are replaced.

## Restrictions

- Requires local `feat/identity-organization-onboarding`, pinned D15C-4B source at historical Git ref `78e6640`, PostgreSQL 16 CLI/server installed, reviewed local `.env` (only checked for a local connection; no protected connection), Linux, and the previously installed 2F2J files.
- Do not pass PostgreSQL connection environment variables, production mode, inherited Node flags or other PostgreSQL live exercise approvals.
- The `--plan` mode performs **no operations**. The `--verify` mode verifies sources, generates **no** disposable cluster and runs **37** offline tests (15 new + 22 from 2F2J).
- The independent `--exercise-disposable` mode requires exactly `PULSE_APPROVE_2F2K_DISPOSABLE=RUN_SYNTHETIC_ONE_TENANT_AND_DESTROY` and **only** creates/mutates disposable test data under the reviewer's lifecycle. It has no mode for a persistent database.
- The retained customer development cluster under `/var/lib/postgresql/pulse-metrics-dev-5u2` at port `55433` and its retained backup remain untouched.
- The generated complete script is written only to a strict, owner-owned `scripts/.pulse-d15c5u2f2k-XXXXXXXX.sh`, is parsed and executed, and removed on completion. The original reviewed cleanup trap stops and deletes the disposable PostgreSQL cluster and reports `PASS: disposable quota PostgreSQL cluster removed`. Both live SQL success and destruction messages are necessary for overall success.

## Verification commands

```bash
cd ~/Projects/pulse-metrics

env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS \
    -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/run-disposable-one-tenant-identity.sh --plan

env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS \
    -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/run-disposable-one-tenant-identity.sh --verify
```

When the verification above passes and an operator deliberately approves the **fully disposable test only**, a separate exact command is:

```bash
cd ~/Projects/pulse-metrics

env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS \
    -u DATABASE_URL -u MIGRATION_DATABASE_URL \
    PULSE_APPROVE_2F2K_DISPOSABLE=RUN_SYNTHETIC_ONE_TENANT_AND_DESTROY \
  bash scripts/telemetry-persistent/run-disposable-one-tenant-identity.sh \
    --exercise-disposable
```

Run the protected read-only offline inspector before and after the exercise as an additional independent check if required by your existing local process. **Never** alter 55433 state, loosen filesystem or database privileges, or edit existing original migration files to make the disposable test pass.

## What completion proves — and does not prove

Successful local `--verify` proves new offline code checks passed. A successful independently approved `--exercise-disposable` would additionally provide **actual PostgreSQL 16** evidence of one synthetic owner/member/agent/credential and positive/negative identity audit outcomes, and confirm that the disposable source was destroyed.

It does **not** establish real WorkOS authentication, operator ownership of an actual customer tenant, independently trusted 2F2I signing key, readiness of the protected persistent cluster for nonzero rows, recoverability of retained customer data, production access controls, or permission to launch.

**NO PRIVATE CUSTOMER DATA | NO ENROLLMENT | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO**
