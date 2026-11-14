# Pulse Metrics — D15C-5I: Durable Synthetic Decision Replay Ledger

**Status:** REVIEW ONLY — disposable offline security test, not production infrastructure.
**Public SaaS launch:** **NO_GO**.
**Parent checkpoint:** committed D15C-5H on `feat/identity-organization-onboarding`.

## Objective

D15C-5H verified signed synthetic operator decisions but tracked used decision nonces in an in-memory `Set`. A fresh process loses that set. This D15C-5I **offline test** persists the synthetic signed decision's nonce, alert key, attestation hash and decision hash in an owner-only SHA-256-linked journal, then verifies it after a new Node process starts. A **separate local Ed25519-signed frozen checkpoint** detects changed ledger heads. No real database, operator identity, delivery destination, scheduler, role grant or external custody is introduced.

Seven NEW complete files (zero existing files replaced):

1. `README-D15C-5I.md` — scope, commands and limitations.
2. `docs/security/D15C-5I-PERSISTENT-REPLAY-CUSTODY-DESIGN.md` — threat model and release blockers.
3. `scripts/telemetry-maintenance/durable-decision-ledger.mjs` — strict private ledger, exclusive writer lock, fsync, separate signed checkpoint and no-live guard.
4. `scripts/telemetry-maintenance/durable-decision-ledger.test.mjs` — 25 negative and positive unit tests.
5. `scripts/telemetry-maintenance/durable-decision-rehearsal.mjs` — five disposable directories, real D15C-5D–5H fixture integration, distinct child writer/verifier processes.
6. `scripts/telemetry-maintenance/verify-durable-decision-candidate.mjs` — pinned SHA-256 source manifest (read-only).
7. `scripts/test-maintenance-durable-decision-rehearsal.sh` — fail-closed launcher plus source, negative-guard and unit checks.

## Security claims that are NOT made

- A persisted decision **does not prove human identity, acknowledgement, authorization or permission to retransmit**. The only recorded synthetic decisions are `review_no_replay` and `escalate_no_replay`.
- A local `fsync` and an exclusive directory lock test crash tolerance **in this simulation**, not actual redundant storage or cross-host concurrency guarantees. A stale lock is refused and requires manual review.
- The second Ed25519 checkpoint is signed by an **ephemeral local test key**, stored in a second **local** directory controlled by the same test user. It demonstrates a trust boundary but **does NOT provide independently controlled external custody or a true anti-rollback guarantee**.
- A malicious process could remove both local stores before a checkpoint is separately trusted. A real service needs dedicated custody identity, protected external storage, durable monotonic anti-replay state, key rotation and revocation, backup/recovery, two-person approval and security audit.
- No real delivery receipts or production-maintenance grants exist in this package. Keep live endpoints and scheduling disabled.

## Install (only new paths)

```bash
cd ~/Projects/pulse-metrics
git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5i-durable-replay-custody-review.zip
unzip -n ~/Downloads/pulse-metrics-d15c5i-durable-replay-custody-review.zip
```

`unzip -n` will not overwrite an existing path. Check the seven expected untracked filenames before committing; leave older troubleshooting notes unstaged.

## Run offline security rehearsal

```bash
cd ~/Projects/pulse-metrics
bash scripts/test-maintenance-durable-decision-rehearsal.sh
```

Expected terminal markers:

```text
PASS: D15C-5I source hashes verified; prior 5H contract remains pinned
PASS: D15C-5I unsafe production, database, delivery and operator settings denied
PASS: 5D–5H signed and frozen evidence verified; ambiguous in-flight send remains blocked
PASS: separate writer exits without response AFTER fsynced decision; ledger survives crash
PASS: separately signed test-only checkpoint pinned to durable ledger head
PASS: fresh verifier with public keys only rejects replay after restart
PASS: rewritten hash-linked ledger cannot bypass separately signed frozen checkpoint
PASS: forged checkpoint refused; no human, external custody or live authorization claimed
D15C-5I DISPOSABLE DURABLE NONCE AND SIGNED CHECKPOINT REHEARSAL PASSED
PASS: five disposable private audit, outbox, witness, ledger and checkpoint directories removed
========== D15C-5I OFFLINE REPLAY/CUSTODY REVIEW: ALL CHECKS PASSED ==========
PUBLIC LAUNCH: NO_GO | no production operator, customer DB, alerts or scheduler
```

## Verify application remains healthy

```bash
npm run lint && npm test && npm run build && git diff --check && git status -sb
```

The dedicated rehearsal's 25 tests are independent from the existing application test runner; do not assume `npm test` alone covers this milestone. Do not commit the D15C-5I candidate until the actual workstation rehearsal passes and the seven-file stage list is reviewed.

## Next design gate

A future milestone may examine real separately administered custody, atomic shared replay state, test-only revocation/rotation, resilience to hostile filesystem change, and operational human acknowledgement. These require their own approval and integration; the current launch decision remains **NO_GO**.
