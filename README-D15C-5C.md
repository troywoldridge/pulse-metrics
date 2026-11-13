# Pulse Metrics — D15C-5C: Controlled Maintenance Operations

**Status: REVIEW ONLY — synthetic disposable PostgreSQL rehearsal.**
**Public SaaS launch: NO_GO.**

## Scope and provenance

Builds from **GitHub checkpoint `d394d194d3509f6767031b24fce81aead99878e2`**
(`feat/identity-organization-onboarding`, D15C-5B committed). The package adds
seven NEW files and does not modify existing application code, protected
PostgreSQL migrations, privilege manifests, D15C-5B sources, or real
configuration. It has **no deployment identity, no production operational
approval, no `cron`/`systemd` schedule, no customer endpoint and no remote DB
capability**. The SQL maintenance function is not installed in a real database.

The full D15C-5C rehearsal wrapper is a complete **new** shell script derived
from the previously proven D15C-5B disposable wrapper. It repeats that
predecessor's locked migration replay, HTTP ingestion, RLS/ACL, quota and
concurrency tests in a fresh marker-verified PostgreSQL cluster, with TCP
turned off, on a temporary Unix socket. Its cleanup trap attempts to remove
the independent cluster on success and failure. The original D15C-5B
wrapper is **not changed** and its own source hash is verified.

## Controller policy — test-only

- The CLI refuses execution unless `PULSE_D15C5C_DISPOSABLE_ONLY=YES`, an exact
  `/tmp/pulse-replay-XXXXXXXXXX/socket` path and matching data directory and
  markers are present, with no production mode or PostgreSQL password/
  connection override environment. No arguments, arbitrary SQL or target
  database may be supplied.
- Uses the **existing D15C-5B test-only login** `pulse_metrics_test_maintainer`
  over peer-authenticated local Unix socket. This identity is NOT a real
  maintenance operator; a production-equivalent account and its grant custody
  have yet to be designed and independently reviewed.
- Verifies PostgreSQL session identity, exact data directory, port 55432,
  TCP disabled, function EXECUTE granted, no direct quota-table DELETE and
  no membership in the maintenance function-owner role **before acquiring
  the cooperative lock or calling cleanup**.
- Uses a fixed two-key PostgreSQL **session advisory lock**. A simultaneous
  controller using the same keys reports `overlap_skipped` without running
  cleanup. This is not a security access-control boundary: direct privileged
  function invocation by a different orchestrator does not honor the lock.
- Limits a single invocation to **three autocommitted cleanup calls**, each
  limited by D15C-5A to **250 network and 250 agent rows** older than the
  function's fixed **48-hour after-expiry** safety interval. At most 750 of
  each type are deleted per invocation. No loop can run indefinitely.
- Bounds connection and SQL query durations with client-side and database
  timeouts. A failure terminates this invocation and is never treated as
  success. A PostgreSQL session disconnect releases its advisory lock.
- Emits strictly limited, sanitized `D15C5C_EVENT` JSON lines containing only
  counts and predefined event names. No raw PostgreSQL exception, SQL query,
  socket path, credential, tenant identity, HMAC digest or customer metric is
  written to those events. An `alert: true` is **alert-ready output only**:
  there is no real alert delivery or monitoring service.
- Reaching the third batch with nonzero deletions sets `possibleBacklog: true`;
  this is a conservative follow-up signal, **not a verified backlog size**.
  Likewise an all-zero batch does not prove globally empty tables if rows
  were skipped while locked by another transaction.

## Evidence tested

Unit tests (8) verify bounds, session unlock, overlap rejection, sanitized
errors, compromised query shapes and invalid role/socket denial. The real
isolated PostgreSQL integration exercises:

1. Missing approval flag, production mode and password environment each
   refuse before attempting a database connection.
2. A deliberately held advisory lock makes a concurrent CLI invocation
   skip with no quota table modifications.
3. 770 synthetic expired buckets in EACH table are pruned 750+750 on the
   first bounded run (three batches), with `possibleBacklog: true`.
4. A second run deletes the remaining 20+20 while two active/recent rows
   in each table survive. A no-work invocation remains bounded.
5. A PostgreSQL session disconnect releases a held lock; a subsequent
   real CLI invocation succeeds.
6. Revoking the disposable caller's EXECUTE on the maintenance function
   produces only a safe, nonzero `maintenance_failed` event. The disposable
   grant is restored for a final read-only ACL audit.
7. The full historical telemetry, migration receipts, RLS and permissions
   remain intact. No scheduler or production API is enabled.

**Source checks in the package author's environment:** Node syntax, Bash
syntax, independent source fingerprints, ZIP integrity, and 8/8 mocked policy
unit tests passed. **The new real PostgreSQL rehearsal has NOT been run**;
its result must be provided from the developer workstation. Do not report
5C as complete until that evidence is reviewed.

## Install (only in the Pulse Metrics project root)

```bash
cd ~/Projects/pulse-metrics
unzip -l ~/Downloads/pulse-metrics-d15c5c-controlled-maintenance-review.zip
unzip -n ~/Downloads/pulse-metrics-d15c5c-controlled-maintenance-review.zip
```

All paths are new. If any already exists, stop and inspect the collision;
`unzip -n` will not overwrite preexisting work.

## Static and application checks

```bash
cd ~/Projects/pulse-metrics
node scripts/telemetry-maintenance/verify-operations-candidate.mjs
node scripts/telemetry-maintenance/verify-contention-candidate.mjs
node scripts/telemetry-maintenance/verify-candidate.mjs
node --test scripts/telemetry-maintenance/controlled-maintenance.test.mjs
bash -n scripts/test-telemetry-controlled-maintenance-rehearsal.sh
node --check scripts/telemetry-maintenance/controlled-maintenance-cli.mjs
node --check scripts/telemetry-maintenance/controlled-maintenance.integration.mjs
npm run lint
npm test
npm run build
git diff --check
```

## Disposable PostgreSQL operational rehearsal

```bash
cd ~/Projects/pulse-metrics
bash scripts/test-telemetry-controlled-maintenance-rehearsal.sh
```

Expected final markers, **if all checks truly pass**:

```text
D15C-5C DISPOSABLE MAINTENANCE OPERATIONS PASSED
PASS: revoked test-only maintenance permission failed closed with no SQL disclosure
D15C-5C DISPOSABLE OPERATIONS REHEARSAL: ALL CHECKS PASSED
PUBLIC LAUNCH: NO_GO | review-only, no real operator, scheduler, network or endpoint
PASS: disposable quota PostgreSQL cluster removed
```

The prerequisite D15C-5B tests run again first. If a permission failure,
timeout, wrong count, or identity mismatch occurs, stop; do not weaken the
ordinary application role, edit locked SQL, touch real `.env` credentials or
install a migration. Report sanitized terminal output for a complete-file fix.

## Limits before the next milestone

- No real production maintenance operator identity, secret management, or
  independent release authorization.
- No durable maintenance-run ledger, external audit, operational uptime
  monitoring, alert destination, service supervision, or actual scheduler.
- No tested real database pool failure, high-volume cadence, crash recovery,
  WAL/PITR, encrypted backups or operational RPO/RTO.
- No deployment approval or live telemetry activation. Maintain NO_GO.

**Next:** reviewed operator identity/custody, external alert delivery,
maintenance-run evidence and a separately authorized staging scheduling plan.

**Pulse Metrics — Built to Last.**
