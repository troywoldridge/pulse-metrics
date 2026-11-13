# Pulse Metrics — D15C-5E: Maintenance Identity and Alert Delivery Design

**Status: REVIEW ONLY — offline, no production functionality.**  
**Commercial launch: NO_GO.**  
**Parent milestone:** D15C-5D tested and committed on branch `feat/identity-organization-onboarding` after D15C-5C commit `e9dcc29`.

## What this milestone is

A new, self-contained offline review contract for **proposed** maintenance operator identity, local audit receipt verification, alert idempotency previews and escalation handling. No live database identity or grant is created. Nothing sends notifications, uses HTTP, schedules work, or touches a customer database.

This builds on the **existing, pinned D15C-5D** `maintenance-audit-policy.mjs` only inside the synthetic rehearsal. The prior 5D source must be present and verified. The package adds **seven new files** (README, design document, contract module, unit tests, offline demonstration, verifier and shell launcher). No prior file is replaced.

## Contents

- `docs/security/D15C-5E-OPERATOR-ALERT-DESIGN.md` — review architecture, custody boundaries, threat model, release blockers and required future tests.
- `scripts/telemetry-maintenance/operator-alert-contract.mjs` — pure, fail-closed design review functions; returns `review_required`, NEVER approval.
- `scripts/telemetry-maintenance/operator-alert-contract.test.mjs` — 14 unit tests of least-privilege proposals, unsafe fields, SHA receipt checks, severity and bounded retry previews.
- `scripts/telemetry-maintenance/operator-alert-dry-run.mjs` — guarded isolated `/tmp` journal demonstration that creates three synthetic 5D records, checks no-send behavior and deletes only its own files.
- `scripts/telemetry-maintenance/verify-operator-alert-candidate.mjs` — read-only source fingerprint verifier.
- `scripts/test-maintenance-operator-alert-design.sh` — offline orchestration; verifies the previous 5D pinned sources, all 5E sources, unit tests and explicit refusal tests.
- `README-D15C-5E.md` — install and evidence.

## Important security limits

- The proposal's `pulse_metrics_maintenance_runner` is **only a future role name**, not an existing PostgreSQL account or actual credential.
- `reviewOperatorProposal` will never issue a production-ready yes. A claimed identity plan or local test is not proof of authorization.
- Local SHA-256 audit checks detect unintentional or naive tampering, but cannot stop a malicious party who can rewrite the entire hash chain. Independent externally controlled custody is still a launch prerequisite.
- Reproduced idempotency keys and retry results are **previews**, not durable-outbox messages, actual retries, delivery receipts or human acknowledgement.
- Do **not** create database roles, paste credentials, change `pg_hba.conf`, enable a scheduler, configure email/webhooks or connect to public infrastructure for this exit.

## Install (new paths only)

```bash
cd ~/Projects/pulse-metrics
git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5e-operator-alert-design-review.zip
unzip -n ~/Downloads/pulse-metrics-d15c5e-operator-alert-design-review.zip
```

If any target file unexpectedly exists, review it before proceeding. `unzip -n` will not overwrite it.

## Offline checks on your Linux workstation

```bash
cd ~/Projects/pulse-metrics
node scripts/telemetry-maintenance/verify-audit-candidate.mjs
node scripts/telemetry-maintenance/verify-operator-alert-candidate.mjs
node --test scripts/telemetry-maintenance/operator-alert-contract.test.mjs
bash -n scripts/test-maintenance-operator-alert-design.sh
bash scripts/test-maintenance-operator-alert-design.sh
npm run lint
npm test
npm run build
```

**Expected** final markers:

```text
PASS: D15C-5E missing approval, production mode and libpq password refused
PASS: D15C-5E verified three synthetic 5D audit receipts
PASS: warning and critical previews are deduplicated and NOT delivered
PASS: exhausted retry requires manual dead-letter/escalation review
D15C-5E OFFLINE CONTRACT REHEARSAL PASSED
PASS: disposable private audit journal removed
========== D15C-5E OFFLINE DESIGN REVIEW: ALL CHECKS PASSED ==========
PUBLIC LAUNCH: NO_GO | review only; no permissions, webhooks, email or scheduler
```

**Do not commit this candidate until the actual workstation checks pass and the staged file list is reviewed.** This milestone is an offline *design and contract* milestone, not the real-operator or delivered-alert milestone.

## Subsequent work

Design-review acceptance and a separate independently authorized provisioning strategy are needed for a real service identity, external audit custody, durable outbox and real alert delivery. That future work must be staged and reviewed independently, with stronger integration testing and a production readiness decision; the default is **NO_GO**.
