# Pulse Metrics — D15C-5J Production Security Architecture Review

**Status:** REVIEW ONLY — architecture proposal and offline contract; NOT a deployment.
**Commercial launch:** NO_GO.
**Branch:** `feat/identity-organization-onboarding` (after committed D15C-5I).

## Why 5J is different

D15C-5C through 5I proved a series of controlled *test* security behaviors, including local crash-surviving replay prevention and signed test-key custody checkpoints. They did not create an independently administered custodian, real operator, distributed durable ledger, maintenance identity or production delivery infrastructure.

This exit establishes a **proposed production trust architecture** and an explicit set of **16 unverified release gates**, using the project's accepted PostgreSQL, Drizzle, tenant isolation, real telemetry, outbound agents and incremental infrastructure principles. The package itself performs no database operations, HTTP requests, cloud calls, IAM operations, grants or scheduler actions.

## Nine NEW files, no overwrites

1. `README-D15C-5J.md` — review scope and instructions.
2. `docs/architecture/ADR-010-SECURE-MAINTENANCE-OPERATIONS.md` — proposed ADR; not accepted, no platform chosen.
3. `docs/security/D15C-5J-PRODUCTION-TRUST-BOUNDARIES.md` — trust diagram, matrix, threat model, unverified controls and future tests.
4. `docs/security/D15C-5J-RELEASE-GATE-REGISTER.json` — 16 requirements; every one marked `external_verification_required`.
5. `scripts/telemetry-maintenance/production-security-boundary.mjs` — pure review-only contract, rejects unsafe topology and fake release approvals.
6. `scripts/telemetry-maintenance/production-security-boundary.test.mjs` — security tests: no self-approval, no shared maintenance role, no untrusted custody or auto replay.
7. `scripts/telemetry-maintenance/production-security-boundary-rehearsal.mjs` — sanitized offline launch-denial and release-gate checks, using existing committed 5E/5H/5I contracts.
8. `scripts/telemetry-maintenance/verify-production-boundary-candidate.mjs` — read-only SHA-256 source fingerprint verifier.
9. `scripts/test-maintenance-production-boundaries.sh` — guarded offline command including inherited source verifications and negative tests.

## Architecture recommendation

- Continue using **PostgreSQL** as the first candidate shared transactional outbox, nonce and idempotency store; a future migration must enforce the transactional invariants with concurrent, multi-worker negative tests.
- Create a **dedicated maintenance workload principal**, distinct from `pulse_metrics_app`, migration login and telemetry identity, with EXECUTE-only access to the exact bounded routine. This is **not created by 5J**.
- Place signed audit/decision evidence in a **separately administered retention-protected external custody domain**. A vendor, retention period and independent key management service still need review and approval.
- Require verified and currently authorized human operators, separate approval for high-risk recovery, revocation and nonce uniqueness; do not infer human acknowledgement from HTTP acceptance.
- Block ambiguous `in_flight` sends, public launch, external alerts, scheduled cleanup, new database rights and production changes until independent evidence and change approvals exist.

## Install new paths only

```bash
cd ~/Projects/pulse-metrics
git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5j-production-architecture-review.zip
unzip -n ~/Downloads/pulse-metrics-d15c5j-production-architecture-review.zip
```

Use `unzip -n` and inspect any path collision; never overwrite a pinned 5C–5I file.

## Run offline test suite

```bash
cd ~/Projects/pulse-metrics
bash scripts/test-maintenance-production-boundaries.sh
```

Expected final markers:

```text
PASS: D15C-5J source hashes and release register pinned SHA256
PASS: D15C-5J review guard rejects production, PG, destination and fake approval overrides
PASS: D15C-5J committed 5E/5H/5I zero-live capability invariants preserved
PASS: proposed API, ingress, maintenance, custody and operator boundaries distinct
PASS: sixteen release requirements remain unverified; source JSON cannot approve deployment
PASS: shared database role, fake approval and untrusted evidence refused
PASS: all automatic ambiguous retries, fake human acknowledgements and grants denied
D15C-5J OFFLINE PRODUCTION TRUST-BOUNDARY REVIEW PASSED
========== D15C-5J PRODUCTION ARCHITECTURE REVIEW: ALL CHECKS PASSED ==========
PUBLIC LAUNCH: NO_GO | documentation and offline assertions only; no provider selected
```

The new security tests are separate from the main application test runner. Additionally run:

```bash
npm run lint && npm test && npm run build && git diff --check && git status -sb
```

Confirm the nine intended 5J files are the only new staged changes. Older troubleshooting README files must remain unstaged. Preserve historical migrations and role grants.

## What verification does not establish

This exit cannot prove that a real cloud workload exists, an operator is human, SQL migration permissions are correct in deployment, an external custodian is independently controlled, or an alert can be recovered under real outage. The machine-readable release inventory is **not an authorization system** and the verifier checks only pinned local candidate source files. Release readiness remains **NO_GO**.

## Next suggested exit

D15C-5K: finalize deployment-platform and custody choices, document signed acceptance of ADR-010 and turn the first approved boundary into an independently reviewed, disposable integration plan (not real production activation).
