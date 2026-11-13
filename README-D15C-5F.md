# Pulse Metrics — D15C-5F: Isolated Alert Handoff Rehearsal

**Status: REVIEW ONLY / loopback-only synthetic alerts. Public launch: NO_GO.**

## Scope

This is a follow-on to committed D15C-5E operator/alert design. It adds **seven new files only** and does not modify pinned D15C-5A/B/C, D15C-5D or D15C-5E source files, migrations, environment, database roles, RLS, application APIs or running services.

Unlike 5E's preview-only checks, this isolated integration sends synthetic events to a freshly created HTTP fake receiver **bound exclusively to 127.0.0.1** on a random local test port. It cannot contact a recipient, cloud service or arbitrary URL. The receiver is removed as soon as the test exits. The local disposable outbox and journal are created with 0700 directories and 0600 files and deleted on cleanup. This is neither a commercial delivery mechanism nor a real service identity.

### New files

- `README-D15C-5F.md` — this install and test guide
- `docs/security/D15C-5F-ISOLATED-ALERT-HANDOFF-DESIGN.md` — threat model and non-production boundaries
- `scripts/telemetry-maintenance/isolated-alert-handoff.mjs` — local outbox state machine, guarded loopback adapter, strict test HMAC and review-only identity checks
- `scripts/telemetry-maintenance/isolated-alert-handoff.test.mjs` — unit/security tests of file, state and transport boundaries
- `scripts/telemetry-maintenance/isolated-alert-rehearsal.mjs` — synthetic 5D receipts -> outbox -> ephemeral fake receiver integration
- `scripts/telemetry-maintenance/verify-isolated-alert-candidate.mjs` — offline full-source SHA-256 pin verifier
- `scripts/test-maintenance-isolated-alert-rehearsal.sh` — reproducible refusal and integration checks

### Important distinctions

The controller is **not** switched on, there are no real maintenance operators, and this milestone performs **no PostgreSQL work**. HTTP `202` from the loopback mock is evidence that the **test fake receiver** accepted an event, **not** that any alert was delivered or read by a person. `409` only proves a duplicate receipt is handled safely. A local SHA-256 journal or atomic outbox does not provide externally protected custody or high-availability delivery.

The private outbox is persisted before a local HTTP test. Each send requires an explicit attempt transition; after a crash in an ambiguous `in_flight` state the record cannot be retried automatically. Temporary failure is manually retried at most three times. Production credentials and public endpoints must not be added for this milestone.

## Install (new file paths only)

Download `pulse-metrics-d15c5f-isolated-alert-handoff-review.zip` to your Downloads directory, then:

```bash
cd ~/Projects/pulse-metrics
git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5f-isolated-alert-handoff-review.zip
unzip -n ~/Downloads/pulse-metrics-d15c5f-isolated-alert-handoff-review.zip
```

If `unzip -n` reports an existing file, stop and inspect the collision rather than overwriting existing work. Old diagnostic READMEs may remain untracked; do not include them in this milestone.

## Offline + loopback integration tests

```bash
cd ~/Projects/pulse-metrics
bash scripts/test-maintenance-isolated-alert-rehearsal.sh
```

Expected final markers, subject to real verification on your Linux machine:

```text
PASS: D15C-5F missing approval, production, PG override, and external URL refused
PASS: four linked synthetic audit records verified; no-alert ignored
PASS: 0600 private outbox durably queued exact SHA-backed candidates
PASS: wrong HMAC rejected; 503 retried explicitly and 202 receipt persisted
PASS: three temporary failures dead-lettered without automatic retry loop
PASS: receiver 409 is an idempotent transport receipt, not human acknowledgement
PASS: malformed local outbox fails closed; proposed operator remains unverified
D15C-5F ISOLATED LOOPBACK DELIVERY REHEARSAL PASSED
PASS: disposable private journal and outbox removed
========== D15C-5F REVIEW-ONLY LOOPBACK REHEARSAL: ALL CHECKS PASSED ==========
PUBLIC LAUNCH: NO_GO | no operator, scheduler, production alerts or external destinations
```

## Application verification

```bash
cd ~/Projects/pulse-metrics
npm run lint
npm test
npm run build
git diff --check
git status -sb
```

Do not commit until both the loopback rehearsal and application checks pass on your workstation. Preserve prior sources and no real production credentials, jobs, alert routes or permissions should be created. A separate security-approved rollout will be needed for any actual delivery or operator provisioning.
