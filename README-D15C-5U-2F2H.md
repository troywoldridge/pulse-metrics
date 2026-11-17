# Pulse Metrics — D15C-5U-2F2H: Live PostgreSQL Inventory Adapter

**Status:** Candidate for local verification, not yet live-verified
**Scope:** Read-only, empty-only audit of quarantined PostgreSQL 16 on the exact private Unix socket/port 55433.
**Public launch:** **NO_GO**
**Persistent agent enrollment and telemetry writes:** **NOT AUTHORIZED**

## What this adds

Four complete new files under `scripts/telemetry-persistent/`:

1. `pilot-live-inventory.sql` — a pinned `BEGIN ... REPEATABLE READ READ ONLY` SQL statement set. It verifies the exact protected data directory, socket, port, TCP-off configuration, migration receipts and absence of *all* operational data, including private tokens, audit events and quota tables. It probes unscoped telemetry access with `SET LOCAL ROLE pulse_metrics_app`, resets the role, and emits exactly one nonsecret JSON inventory. It computes sample/submission linkage, agent ownership, RLS and grant indicators for the 2F2G policy.
2. `validate-live-pilot-inventory.mjs` — accepts exactly one bounded JSON record on stdin and calls the already-reviewed `assessPilotInventory` with **hardcoded `{version:1,mode:'empty'}`**. It never accepts tenant IDs, bounded policies or approval through user input. On success it prints a sanitized result, not the inventory.
3. `guarded-live-inventory.sh` — new independent `--plan`, `--verify`, and `--exercise-empty` operator. It pins the old zero-row operator, corrected 2F2G guard/policy, frozen backup/inspector, and the two new source hashes. The live exercise independently requires `PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY=START_READ_ONLY_SNAPSHOT_STOP`, delegates already-verified PostgreSQL startup, executes only the pinned read-only SQL, validates the policy, reruns zero-row security auditing, and **mandatorily stops the exact cluster**. It verifies the stopped cluster and retained same-host backup on exit, including failure exits.
4. `live-pilot-inventory.test.mjs` — 15 offline checks for source parsing, refusal behavior, approval isolation, read-only SQL, no secrets, nonzero denial, tamper detection and mandatory cleanup code.

The approved 2F2G source files, 2F2D recovery operator, migrations, retained backup, Git branch and application entrypoints are **not modified**. These are new files only.

## Expected use on `adap`

1. Verify ZIP/file SHA256 values before installation. Refuse if any new destination file exists.
2. Install the three files plus tests/README as complete files (do not partially patch older sources).
3. Run `bash -n`, `node --test scripts/telemetry-persistent/live-pilot-inventory.test.mjs`, and the new operator `--plan` and `--verify` without approval. Verify that no PostgreSQL server starts.
4. Separately run the approved `--exercise-empty` only if all previous checks pass. Review the complete output; the same-host snapshot must remain verified and the source stopped.

Expected live completion markers, **not yet observed**:

```
PASS: exact read-only PostgreSQL inventory satisfies empty pilot policy; no secrets emitted
========== D15C-5U-2F2H LIVE EMPTY INVENTORY AUDIT: PASS ==========
========== 2F2H MANDATORY TARGETED STOP / RECOVERY VERIFICATION ==========
PASS: source cluster remained stopped and original development DB unchanged
```

**Stop and investigate** if any test fails, if the cluster remains running, if the retained backup integrity changes, or if source digests differ. Do not manually remove, repair or overwrite PostgreSQL directories.

## Security and accuracy limits

- The SQL adapter is intentionally **empty-only**. An existing nonzero database is refused; it must *not* be used to activate real samples.
- One-agent bounded inventory is still an **offline policy contract**. This does not test nonzero reads against the protected cluster, and it does not constitute an independently approved tenant/agent authorization manifest.
- PostgreSQL startup can update PostgreSQL-owned control/WAL files as part of normal operation, but the audit performs **no application writes** and enables no ingest route.
- It is a same-host local development backup, not a production recovery plan, encrypted/offsite backup, or point-in-time recovery (PITR).
- A subsequent milestone must validate a **separate nonzero-data operator with approved identities and a recovery transition** before any persistent telemetry ingestion.
