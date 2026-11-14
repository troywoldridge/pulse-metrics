# Pulse Metrics — D15C-5G: Offline Alert Recovery & Frozen Witness

**Status: REVIEW ONLY — local synthetic evidence. Public launch: NO_GO.**

## Milestone and source boundaries

D15C-5F isolated alert handoff was already verified and committed on
`feat/identity-organization-onboarding`. This package introduces exactly
**seven new files**. It does NOT alter committed 5C/5D/5E/5F sources, pinned
SQL migrations, application code, environment, database roles, credentials,
authenticated ingestion paths, scheduler or any deployment.

D15C-5G extends the earlier test-only SHA journal and durable local outbox with
a separate **frozen, disposable local witness**. The witness records the
validated journal's record count and terminal hash and the outbox's record
count and content digest. It detects changes *relative to that original local
snapshot*, including a locally recomputed journal hash chain or an outbox
mutation. It is **not external custody, an immutable store or an independent
signature**. The same test user owns every file.

## New files

- `README-D15C-5G.md` — install and verification guide
- `docs/security/D15C-5G-RECOVERY-WITNESS-DESIGN.md` — recovery threat model,
  permission and acknowledgement boundaries, commercial readiness blockers
- `scripts/telemetry-maintenance/alert-recovery-anchor.mjs` — new local witness
  policy, journal/outbox reconciliation, review-only status counts and guard
- `scripts/telemetry-maintenance/alert-recovery-anchor.test.mjs` — security
  regression tests with no HTTP, database or infrastructure dependencies
- `scripts/telemetry-maintenance/alert-recovery-rehearsal.mjs` — disposable
  local integration, with a second Node process simulating a fresh restart
- `scripts/telemetry-maintenance/verify-recovery-candidate.mjs` — read-only
  complete source hash verifier for the six other files
- `scripts/test-maintenance-alert-recovery-rehearsal.sh` — reproducible
  refusal checks and complete offline test invocation

## Tested recovery behavior

Six separate durable 5F states are exercised (pending, in-flight, retry
pending, receiver accepted, receiver duplicate and dead letter), plus one
eligible alert missing from the outbox. The result is always a manual-review
plan, never an authorization for a send, retry, operator identity or human
acknowledgement. A second Node process reads the persisted snapshot and
refuses replay of the interrupted in-flight message. Local history rollback,
forged human acknowledgement and altered witness content fail closed.

Unsafe commands with production mode, absent approval, PostgreSQL password or
connection overrides, external delivery/witness URLs, claimed operator
identity or unexpected CLI arguments are rejected BEFORE local files are read.
This rehearsal opens **no socket, network connection, database or API**.

## Install on your workstation (new files only)

Download `pulse-metrics-d15c5g-offline-recovery-review.zip` to Downloads.

```bash
cd ~/Projects/pulse-metrics

git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5g-offline-recovery-review.zip
unzip -n ~/Downloads/pulse-metrics-d15c5g-offline-recovery-review.zip
```

If a path unexpectedly exists, **stop and inspect** before proceeding;
`unzip -n` intentionally does not replace files. The older troubleshooting
README files may remain untracked without being included in this milestone.

## Run offline security rehearsal

```bash
cd ~/Projects/pulse-metrics
bash scripts/test-maintenance-alert-recovery-rehearsal.sh
```

**Expected** final markers — these must be confirmed on your machine:

```text
PASS: D15C-5G all unsafe configurations denied before file access
PASS: six durable synthetic outbox statuses plus missing-alert evidence created
PASS: frozen separate local witness verified audit head and complete outbox snapshot
PASS: fresh Node process sees interrupted send and refuses ambiguous replay
PASS: forged acknowledgement, history rollback and witness corruption rejected
PASS: receiver acceptance is not human acknowledgement; dead-letter requires review
D15C-5G DISPOSABLE RECOVERY AND LOCAL WITNESS REHEARSAL PASSED
PASS: three disposable private audit, outbox and witness directories removed
========== D15C-5G OFFLINE RECOVERY REVIEW: ALL CHECKS PASSED ==========
PUBLIC LAUNCH: NO_GO | no real custody, operators, recipients or scheduled work
```

## Application checks before commit

```bash
cd ~/Projects/pulse-metrics
npm run lint
npm test
npm run build
git diff --check
git status -sb
```

Do **not commit** until the local D15C-5G rehearsal and application checks have
passed. Stage *only* these seven new milestone files. This is still a
review-only offline milestone; no customer-facing SaaS launch is authorized.
