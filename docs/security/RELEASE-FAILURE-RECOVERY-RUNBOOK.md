# Pulse Metrics — Phase 2E3C5D4: Interrupted Release Recovery

**Status:** Strictly isolated synthetic rehearsal. **Not a production release, recovery command or authorization to access customer databases.**

**Expected reviewed Git checkpoint:** `33a57aca49c7cc90cb1641cc29ce7e06dd612454` on `feat/identity-organization-onboarding`.

## Purpose

Phase 2E3C5D3 established one transaction containing the test migration and release receipt, with a session-level cooperative PostgreSQL advisory lock and two separately signed **synthetic** approvals. This phase adds failure classification and tests the difference between a transaction known to be aborted and a commit whose outcome the **caller** does not know.

An interrupted client is not evidence that a transaction failed. Never execute a migration twice simply because the caller did not see a COMMIT result. The authoritative decision requires a new trusted connection, the exact database target, a held release lock, the pinned baseline, and corroborating schema + durable release-receipt evidence.

## Strict safety boundaries

- `bash scripts/test-release-failure-recovery-rehearsal.sh` checks the reviewed local development configuration and existing database catalog **read-only**. All database writes occur against a separate marker-guarded `/tmp/pulse-replay-XXXXXXXXXX` PostgreSQL 16 cluster with peer-auth Unix socket and TCP completely disabled. An administrator checks the isolated data directory before any writes; the Node runner connects only as `pulse_metrics_migrator` and is denied privileged server settings.
- The test reproduces the original Drizzle migration, six pinned privileged SQL scripts and their six fresh-replay receipts on that disposable cluster, then installs the **test-only** private release schema from Phase 2E3C5D3. Neither the working database nor the historical SQL source files are modified.
- All synthetic identities, signatures and data stay local. No real WorkOS users, actual telemetry, secrets, production backups, or customer data are involved. The private test cluster is stopped and deleted by a path/marker-guarded trap.
- Only the original reviewed canary `scripts/release/rehearsal-migration.sql` can execute; its SHA-256 and target release ID are pinned in `scripts/release/release-policy.mjs` and verified before connections.
- The test explicitly terminates **only its own disposable migrator backend**. Never copy the backend-termination step to a real developer or production PostgreSQL server.

## What the drill proves

1. **Outage/unknown evidence:** the pure interpreter returns `QUARANTINE_MANUAL_INVESTIGATION`. No DB connection or optimistic retry.
2. **Real pre-commit failure:** with a session-level release lock held, the synthetic migrator begins a transaction, creates the canary and inserts its release receipt. A second disposable migrator session terminates that backend *before COMMIT*. PostgreSQL must abort the transaction and release the connection's advisory lock. A new independently verified session acquires the same lock, reads the entire receipt relation and checks whether the canary table exists. Both must be absent. This classifies the test state as `ABORTED_VERIFIED_REQUIRE_FRESH_APPROVAL`, **not an automatic retry**.
3. **Fresh synthetic authorization:** the next approved test attempt has newly generated ephemeral Ed25519 keys and signatures. Original approval-policy checks still run first. In a real system a separate operator/reviewer workflow would be necessary; this is not one.
4. **Lost-acknowledgment boundary:** PostgreSQL commits DDL + canary + receipt in one transaction. The test then *deliberately discards the successful COMMIT result at the application boundary*, reporting an unknown outcome to the simulated caller and closing that original session. This is **not** a network disconnect occurring during COMMIT and does **not** prove handling that timing window end to end.
5. **Evidence-based reconciliation:** a separate migrator connection performs the immutable source/ledger/catalog preflight again, acquires the *same* session-level advisory lock, rechecks the baseline and reads all release receipts plus canary state. The exact matching plan hash, migration hash, release ID, independently identified signers and single canary row classify as `APPLIED_VERIFIED_DO_NOT_REPLAY`. No second SQL execution occurs.
6. **Inconsistent evidence:** independent unit tests require quarantine on missing information, no lock, baseline mismatch, unexpected/duplicate receipt, mismatched SQL hash, canary without receipt, receipt without canary, or modified canary. These are deliberately not normalized away.
7. **Final audit:** one test-only receipt, one canary, original Drizzle and six privileged ledger receipts, forced RLS, restricted application role, unchanged public security-catalog fingerprint, and unchanged **read-only** development database catalog. Failures halt immediately; cleanup is guarded and observable.

## Decision matrix

| Evidence collected under the release lock | Decision | Operator action |
|---|---|---|
| Matching single receipt **and** expected synthetic canary | `APPLIED_VERIFIED_DO_NOT_REPLAY` | Record verified completion; **do not** run migration again |
| No receipt **and** no canary, pinned baseline verified | `ABORTED_VERIFIED_REQUIRE_FRESH_APPROVAL` | Investigate root cause; fresh independent approval before a new attempt |
| Missing lock or baseline proof; database unavailable; stale or incomplete evidence | `QUARANTINE_MANUAL_INVESTIGATION` | Stop release activity; no retry, deletion or direct SQL repair |
| Receipt exists without canary, canary without receipt, wrong hash, duplicate or unknown release ID | `QUARANTINE_MANUAL_INVESTIGATION` | Escalate to database/security owner; preserve forensic evidence and backup |

**Important limitation:** A real migration could have nontransactional steps, triggers, external side effects, asynchronous work or arbitrary data changes not represented by a canary row. Therefore even this fail-closed classifier is not sufficient to authorize production rollback or retry. It is an isolated logic rehearsal only.

## Operator incident response runbook (design, not executable production workflow)

1. **Freeze:** pause the release pipeline and queued schema-changing jobs, stop automatic retries, prevent incompatible application rollout. Maintain service status/communications as appropriate. Do **not** delete the receipt, reset Drizzle history, widen role grants, or infer success from a process exit code.
2. **Preserve evidence:** retain artifact digest, approved release plan, independently authenticated operator/reviewer identities, last known server response, release attempt ID, time, deployment logs, audit history, configuration and backup evidence using restricted storage. Do not publish secrets in incident tickets.
3. **Verify target:** through a separately authenticated, approved operator session, prove environment, cluster identity, database ID, current role and original pinned source/ledger. Refuse mismatched targets. Confirm a tested recovery point and independent backup retention before deciding on remediation.
4. **Acquire exclusivity:** one sanctioned release runner must hold the exact cooperative advisory lock on a *dedicated pinned session* for the entire reconciliation. If unavailable, **stop**; do not forcibly terminate another production release session without independent investigation.
5. **Reconcile durable state:** under the lock, reverify immutable migration sources and expected historical ledger; inspect exact receipt, DDL postconditions and migration-specific data invariants. Treat a connection failure as UNKNOWN, not rolled back. If evidence disagrees, quarantine and involve the database/security reviewer.
6. **Determine action:** already applied -> finalize without replay; verified abort -> require a **new two-person approval and validated restore point** before starting a new attempt; unknown -> freeze and investigate. Never blindly rerun non-idempotent SQL. A binary rollback does not undo schema/data changes.
7. **Record independent audit:** capture all attempts, signers, decisions, duration, verified SQL hashes, cross-check results, recovery artifact IDs and incident review in a future tamper-evident, independently controlled operations audit. The current rehearsal prints logs but does **not** implement such durable incident audit storage.
8. **Resume safely:** validate RLS, least privilege, tenant isolation, ingestion and application compatibility. Resume deployments only through explicit incident-owner signoff and agreed communications.

## Further work before production release readiness

- Real authenticated, independently managed operator identities and approval key custody/revocation.
- Trusted, independently retained release-attempt audit **outside** the transactional database ledger.
- Exact plan-to-artifact release promotion and real application/workers coordination.
- Simulated interrupted COMMIT **over an actual connection fault**, untrusted/partial restore validation and recovery after infrastructure restart.
- Nontransactional DDL recovery, incompatible app versions, rolling releases, service drains and compensating actions.
- Encrypted offsite backups, independent restore verification, role credential/key rotation, WAL/PITR, measured RPO/RTO, on-call escalation and incident communications.

## Run locally

```bash
cd ~/Projects/pulse-metrics
node --test scripts/release/recovery-decision.test.mjs
node --test scripts/release/release-policy.test.mjs
bash -n scripts/test-release-failure-recovery-rehearsal.sh
bash scripts/test-release-failure-recovery-rehearsal.sh
node --test scripts/migrations/verify-manifest.test.mjs
npm test
npm run lint
npm run build
npm run db:check
```

The harness requires trusted local `sudo -u postgres`, matching PostgreSQL 16 command-line binaries, Node 22+, and installed dependencies. **No external production database URL may be substituted.** The unit tests and test-only signature logic do not create production authorizations.

**Engineering standard:** unknown is not failed; verified is not approval; an incomplete release must never trigger blind replay. PULSE METRICS — BUILT TO LAST.
