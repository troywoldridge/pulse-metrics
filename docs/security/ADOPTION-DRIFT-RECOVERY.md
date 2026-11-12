# Pulse Metrics — Phase 2E3C5C2A: Adoption drift and failure recovery guardrails

**Status: local-only verification. No adoption write, production migration, or authorization change.**

**Verified starting Git baseline:** `793cae42c0f6a326c3807643b222937b548e0825`.

## Scope

This increment strengthens the existing versioned replay model in three ways:

1. **Existing-installation drift assessment is strictly read-only.** `scripts/migrations/audit-adoption-drift.sh` invokes the existing read-only source, PostgreSQL RLS/grant/function, and migration-history audits, then compares the live catalog against the independently reviewed fingerprint `6dd1b992…e7df977` produced by the preceding clean-cluster replay. The comparison uses metadata only. A mismatch is a stop condition, not permission to change the database. The full fingerprint is pinned in the script. No privileged ledger is installed or populated in the working database.
2. **A missing privileged receipt does not permit blind replay.** `scripts/migrations/step-preflight-assert.sql` is executed *before* each of the original six SQL scripts, inside the already-verified disposable cluster. It requires all prior receipts and checks that the target SECURITY DEFINER function, executor role, and (when applicable) protected table do not already exist. A missing receipt with existing objects fails with `UNRECORDED_EXISTING_OBJECT`. The operator must review the actual objects and execution evidence; do not fake a `fresh_replay` receipt. The existing migration source files remain unchanged and checksummed.
3. **Failure behavior is rehearsed in the disposable cluster.** After a clean replay, the test temporarily deletes a receipt in an uncommitted transaction, runs the real preflight, confirms rejection, and relies on PostgreSQL rollback to restore the receipt. It runs intentionally failing transactional DDL, checks that no table remains and no history was lost, injects a temporary direct-table grant to the ordinary app role, detects the resulting catalog drift, revokes the grant, and confirms catalog parity is restored. The entire cluster is then shut down and removed.

## Trust boundaries

- `scripts/test-fresh-cluster-replay.sh` remains the only launcher for replay DDL. It verifies the temporary server data directory, Unix-only socket and PostgreSQL major version before altering the disposable cluster.
- The existing local `pulse_metrics` database is **read-only** throughout the adoption assessment and structural comparison. Neither Drizzle history nor privileged receipts are inserted there.
- This is a *guardrail* for future formal adoption, not a mechanism to adopt existing databases. The original scripts cannot be safely replayed on an existing installation; future migration adoption needs explicit review, recorded `verified_existing` provenance that is distinct from `fresh_replay`, backups, release controls and a tested restore.
- A matching catalog fingerprint proves equality only for enumerated catalog metadata; it does not prove complete permission equivalence, row contents, historical SQL provenance, actual backup recovery, or readiness for external customers. It must be refreshed with review whenever intentionally adding schema changes.
- PostgreSQL transaction rollback applies to **transactional** DDL. It does not undo external side effects, independent commits or commands that PostgreSQL disallows inside a transaction. The six original scripts and subsequent ledger receipt writes still have a crash gap. The preflight fails closed on evidence of that gap; it cannot eliminate the gap.

## Local verification

```bash
cd ~/Projects/pulse-metrics
set +e
bash scripts/migrations/audit-adoption-drift.sh
bash scripts/test-fresh-cluster-replay.sh
node --test scripts/migrations/verify-manifest.test.mjs
npm test
npm run lint
npm run build
npm run db:check
```

Expected: read-only adoption fingerprint match; six receipts and six skips; `UNRECORDED_EXISTING_OBJECT` detected in the **simulated** crash gap (script prints PASS, not the private diagnostic); failed DDL leaves no table; injected direct-grant drift is detected and cleared; replay fingerprint matches; cluster cleanup succeeds. Existing Drizzle ledger remains one authentic migration.

### Not yet complete

A production-grade adoption workflow, rollback of real application data, migration locking across application instances, blue/green deployment sequencing, signed artifact distribution, new Drizzle schema entries for post-base tables, formal data-backup restore testing, and customer onboarding are separate future work. Do not enable public API or invitation acceptance based on these tests alone.
