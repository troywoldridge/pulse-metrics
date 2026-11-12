# Pulse Metrics — Phase 2E3C5D3: Release locking and approval-gate rehearsal

**Status:** Isolated, synthetic reliability/security rehearsal only. **NOT** a production migration tool, permission to migrate an existing database, enterprise signing service, or proof of operational release readiness.

**Reviewed installation Git checkpoint:** `80941db15520897ab3d8532bd7793afcf3cc3873` (`feat/identity-organization-onboarding`). Earlier milestones 2E3C5D1–D2 established synthetic backup/restore and independent-cluster role recovery.

## Safety and threat boundaries

`bash scripts/test-release-gates-rehearsal.sh` verifies the reviewed `.env` points to a local `pulse_metrics` application role and runs the existing original-database **read-only** adoption/drift audit. It then initializes its own independent PostgreSQL 16 cluster under a marker-guarded random `/tmp/pulse-replay-XXXXXXXXXX` path, disables TCP, and enables strict peer authentication on an explicit private Unix socket at port `55432`. All subsequent SQL *writes* must use that explicit socket and verified data directory. The existing development database is never adopted, migrated, dumped, renamed, seeded or modified. The final comparison checks that its pinned public catalog hash did not change.

The test copies neither real customer data nor real credentials. The test cluster, marker and canary/receipt records are removed in a guarded cleanup trap; a cleanup error makes the test fail and reports the disposable path for manual examination. Never copy this script into a production release job.

## Release plan and approver validation

`release-policy.mjs` pins the reviewed starting commit, database name, exact public security catalog SHA-256, one **synthetic-only** SQL migration SHA-256, six required historical privileged receipts and fixed release ID. Only the reviewed test migration can run. The plan is hashed with a domain-separated SHA-256 digest.

The integration exercise creates two independent **ephemeral** Ed25519 signing keys in memory and a local trusted-key registry: one `operator`, one `reviewer`, with different subject IDs. Each approval signature binds the exact plan digest, registered key identity, subject, role, issued time and expiry. The policy rejects missing/duplicate signers, role impersonation, plan substitution, altered signatures, unknown keys, unexpected fields and expired/future-dated authorizations. A maximum ten-minute approval validity interval is enforced. **Invalid approvals are rejected before a PostgreSQL client is even opened.** Ten no-database regression tests protect these decisions.

**Critical qualification:** Test keys and subjects are fabricated *inside the test process*. No actual humans approve the rehearsal, and there is no independent identity provider, hardware-backed signing, key custody, revocation, secure receipt of approvals, separation-of-duties administration or authenticated operations UI. This proves the policy behavior, **not** production-quality human authorization. Never use the test signing keys, identity labels or approval records as real approvals.

## PostgreSQL locking and transactional rehearsal

The release integration client connects as the **non-superuser** `pulse_metrics_migrator` role using the disposable Unix socket; it never reads `DATABASE_URL`. Before opening a connection it verifies signatures and test-only path constraints. After connecting it verifies server `data_directory`, `listen_addresses`, active database and role. It checks the original immutable SQL manifest, six privileged ledger receipts (via a fixed-logic, test-only SECURITY DEFINER read-only assertion), Drizzle history and pinned public security catalog **before and again after acquiring the lock**.

The runner uses PostgreSQL `pg_try_advisory_lock(integer,integer)` as a fixed, session-level cooperative lock. It refuses a contending second session immediately. The dedicated session stays alive and owns the lock through all SQL statements and the commit; it unlocks explicitly after success or failure. PostgreSQL also releases session advisory locks when a connection ends. A different session proves auto-release after a simulated disconnect.

The **test-only** SQL migration creates a canary table in the private `pulse_release_rehearsal` schema. The DDL, synthetic row and signed-identity release receipt all execute inside **one PostgreSQL transaction** with local lock/statement timeouts. A deliberate `SELECT 1/0` after DDL demonstrates rollback: both the canary object and the release receipt must remain absent. A subsequent approved attempt commits one canary and one receipt. Reusing the same release ID is refused *under the lock*, rather than silently replaying SQL. Receipt fields bind plan/migration hashes and two distinct approvers.

The private test-only release receipt table is owned by `postgres`, has forced RLS, grants only `SELECT`/`INSERT` to the migrator, and grants no schema usage to `pulse_metrics_app`; the migrator has no update/delete rights. This is an **isolated testing fixture**, not a production migration audit architecture. The test's helper function is SECURITY DEFINER as `postgres`; do not install a superuser-owned release helper in the real database. The test-created schema grants CREATE only to the migrator for the canary.

## Tests that must pass

1. Local non-production config, unchanged reviewed source hashes and original development read-only security baseline.
2. Fully isolated PostgreSQL cluster/data-directory/role verification and exact original Drizzle + six privileged SQL replay with historical receipts.
3. Ten Ed25519 approval-policy unit tests, including adversarial approval inputs.
4. Unapproved/tampered plan denied before connecting.
5. Second PostgreSQL session refused while first holds the session advisory lock; no release write occurred.
6. Session termination frees the advisory lock, allowing a new session to acquire it.
7. Mid-migration SQL failure rolls back canary DDL and receipt; no partial-success history.
8. Valid approvals result in one atomic canary/receipt with correct hashes and independently registered identities; a duplicate attempt fails.
9. Historical privileged ledger and Drizzle history unchanged, private release receipt protected, ordinary runtime role still denied access, pinned public catalog identical, original local database remains unchanged.
10. Disposable cluster and all synthetic state removed on exit; shell, manifest, unit tests, TypeScript, Vite and Drizzle checks continue passing.

## Operational limitations and open work

- Advisory locks are **cooperative**: all migration orchestrators must honor the same exact two-key lock and target database. They do not prevent direct superuser DDL or deployments using another database/lock key. Real release governance must centrally enforce one runner and operator permissions. Session pooling is unsafe for owning a release lock unless connection pinning is guaranteed.
- The release receipt shares a transaction with the canary migration. This does **not** make unrelated nontransactional PostgreSQL commands (e.g., `CREATE INDEX CONCURRENTLY`), external side effects or multiple-service deployments atomic. Such steps need separate reviewed state machines and recovery protocols.
- Successful release receipts are stored; denied attempts and failed attempts are printed in the test output, **not** durably written to an independent, tamper-evident operations audit service. Production evidence must include attempts, identities, timestamps, plan hash, approvals, failures, completed steps and independent retention controls.
- The test locks one database only. Production upgrades must also coordinate app versions, background ingestion, queued jobs, API compatibility, maintenance windows and multi-environment deployment identity.
- This phase does not perform live adoption, a real migration, a full production operator approval workflow, restore from encrypted offsite storage, WAL/PITR, key rotation or operational RPO/RTO certification. Recovery/rollback require a rehearsed runbook and independent review before any live change.

## Commands

```bash
cd ~/Projects/pulse-metrics
node --test scripts/release/release-policy.test.mjs
bash -n scripts/test-release-gates-rehearsal.sh
bash scripts/test-release-gates-rehearsal.sh
node --test scripts/migrations/verify-manifest.test.mjs
npm test
npm run lint
npm run build
npm run db:check
```

**Release rule:** Tests passing means *this narrow rehearsal* passed, not that a production deployment is authorized. Do not commit until the diff is reviewed, unexpected generated files are excluded, and all required checks pass.

**Next work:** reviewed production release identity/trusted key enrollment; operator/reviewer workflow; signed immutable artifact provenance; deployment-wide locks and timeouts; fail-closed execution when approvals expire mid-run; durable external audit; real backup and rollback gates; tested recovery with service drains; environment promotion and rollout signoffs.

**Pulse Metrics — Built to Last.**
