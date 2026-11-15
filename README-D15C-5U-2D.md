# Pulse Metrics — D15C-5U-2D: One-time quarantined schema recovery

**Status:** Local-development, narrowly scoped release candidate. **NOT a general-purpose installer.**

**PUBLIC LAUNCH: NO-GO.** No HTTP ingress, SSH collection, automatic monitoring,
customer enrollment, or production database deployment is authorized.

## Verified starting evidence (from D15C-5U-2B3C)

The *separate* persistent PostgreSQL 16 cluster at
`/var/lib/postgresql/pulse-metrics-dev-5u2` was verified cleanly stopped,
with its data retained, original development DB unchanged, and exactly:

- One real Drizzle receipt and six *freshly executed* privileged receipts.
- Enrollment revision 0001 and ingestion revision 0001.
- **No** `pulse_telemetry_quota` or `pulse_telemetry_agent_quota` schemas.
- No organizations, monitored agents, credentials, telemetry, or submissions.

Previous recovery failed when an **immutable, disposable-only** quota migration
correctly refused the persistent cluster. D15C-5U-2C generated three *new*
development-specific SQL candidates, preserving the operational code/grants of
the locked originals, and the derived artifacts passed the disposable real
PostgreSQL rehearsal including HTTP, multi-tenant, concurrency and quota tests.

## Included files

- `scripts/telemetry-persistent/recover-quarantined-development.sh`: complete
  guarded `--plan` and `--apply` workflow. **New file, not a replacement.**
- `scripts/telemetry-persistent/recover-quarantined-development.test.mjs`:
  six offline refusal/syntax/source-structure checks. **New file.**

## Safety boundary and irreversible effects

`--plan` verifies pinned source files and checks the cleanly stopped existing
cluster. **It does not start PostgreSQL or write SQL.**

`--apply` is authorized **only** when the operator supplies
`PULSE_APPROVE_5U2D_PARTIAL_RELEASE=THREE_MIGRATIONS_ONLY`. It:

1. Re-verifies the fixed 5U2D target and checks the previous read-only SQL
   inventory script, including a temporary start and mandatory stop.
2. Starts *only* the fixed PostgreSQL 16 Unix-socket cluster (TCP off) and has
   the `postgres` administrator independently verify data directory, socket,
   database and role.
3. In read-only transactions, demands exact prior schema/receipt counts,
   unpopulated tenant/agent/telemetry tables, original ingestion function-body
   hash, RLS, owner and runtime privileges. Executes original ledger and
   permission audits (read-only). **Any unexpected state refuses all writes.**
4. Regenerates/byte-compares the three new development SQL sources, copies
   each into a 0600 temporary artifact and verifies SHA-256 before executing:
   - `0001_network_quota_dev_candidate.sql`
   - `0002_agent_quota_dev_candidate.sql`
   - `0003_credential_outcome_dev_candidate.sql`
5. Checks migration receipt count and protected permissions after each source.
   Checks original database catalog fingerprint again; stops PostgreSQL and
   verifies clean shutdown **before** reporting success.

It does not rerun Drizzle, enrollment, ingestion, or any of the six historical
privileged migrations. It does not create seed records or a readiness marker.
The recovered cluster stays **quarantined** even after all three SQL revisions
are installed. The older `manage-persistent-development.sh` intentionally
requires a missing readiness marker and must not be used until a later release.

**PostgreSQL's three scripts use separate transactions, not one all-or-nothing
transaction.** If a migration fails after an earlier one commits, this is a
new partial state. The launcher attempts a safe shutdown but does not replay,
rollback successful migrations, delete the data directory, forge receipts, or
retry. Capture output and inspect separately. An uncatchable signal/system
failure may still require manual service verification.

## Install and review

Unzip at the repository root only after verifying the ZIP hash against the
provided delivery command, and ensure neither target path exists. Then:

```bash
bash -n scripts/telemetry-persistent/recover-quarantined-development.sh
node --test scripts/telemetry-persistent/recover-quarantined-development.test.mjs
node scripts/telemetry-persistent/release-candidates.mjs --verify
env -u NODE_OPTIONS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/recover-quarantined-development.sh --plan
```

The `--plan` output should show exactly three candidate SQL hashes and say
`NO DATABASE STARTED | NO SQL CHANGED`.

## Separate one-time schema recovery (only after inspecting the plan)

```bash
env -u NODE_OPTIONS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  PULSE_APPROVE_5U2D_PARTIAL_RELEASE=THREE_MIGRATIONS_ONLY \
  bash scripts/telemetry-persistent/recover-quarantined-development.sh --apply
```

**Do not rerun `--apply` if it fails, and never invoke the prior `--resume` or
`--apply` installers again.** The output is intended to reveal whether it
stopped before, during or after one of the three migrations.

## After schema recovery

Next gates: independent read-only release-state inventory (new audit,
not the old partial-state inspector), tested backup/restore, restart
persistence, RLS tenant adversarial tests as the restricted runtime role,
and separate consent/credential/HTTPS controls for real agent monitoring.

**Keep diagnostic files separate from staged code. Never commit TLS private
keys, `.env`, database data files or PostgreSQL logs.**
