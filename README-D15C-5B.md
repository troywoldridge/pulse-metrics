# Pulse Metrics — D15C-5B: quota cleanup under load

**Status:** Review-only, synthetic, disposable PostgreSQL integration rehearsal.

**Launch approval:** NO_GO. This package does not alter or install any
previously pinned SQL migrations and does not register a scheduler, real
maintenance identity, public telemetry endpoint, or production database job.

## Purpose

D15C-5A established a private `pulse_telemetry_maintenance.prune_expired_quota_buckets()`
function that deletes only quota windows ended more than 48 hours ago,
with a maximum of **250 network rows and 250 agent rows per call**.
D15C-5B verifies that cleanup and the existing atomic quota functions
behave correctly under concurrent PostgreSQL transactions and actual
restricted-role telemetry ingestion.

The full shell wrapper repeats the already reviewed D15B through D15C-5A
migration and authorization rehearsals in an **independent PostgreSQL 16.15
cluster**, under a random verified `/tmp/pulse-replay-XXXXXXXXXX` path. It
requires an explicit peer-authenticated Unix socket, port `55432`, TCP
completely disabled, and a disposable marker. It never connects to or modifies
the original development or customer database. It runs no commands against
any production database. It removes the test cluster on completion; interrupted
cleanup also attempts removal and reports failure if removal is unsuccessful.

## Test-only authentication boundary

The shell wrapper adds two **disposable-only login roles after D15C-5A**:

- `pulse_metrics_test_maintainer`: NOINHERIT/NOBYPASSRLS. Has only USAGE of
  the maintenance schema and EXECUTE of the protected pruning function.
  Cannot directly read, update, or delete quota tables.
- `pulse_metrics_test_fixture`: NOINHERIT/BYPASSRLS, with narrowly scoped
  SELECT, INSERT and `UPDATE(window_end)` on the two private quota tables.
  It simulates a privileged fixture administrator to age synthetic buckets.
  It has **no EXECUTE permission** on the maintenance function and no access
  to application/customer data beyond the test-only quota fixture privileges.
  Its BYPASSRLS capability is confined to this disposable role and cluster;
  never add this account to real deployment roles, grants, or migration sources.

Both accounts use explicit local peer mappings tied to the invoking Linux
user, with no passwords. The ordinary `pulse_metrics_app` role is not a member
of either role and remains unable to call maintenance or delete quota rows.
The original protected executor ownership, RLS, and source fingerprints do
not change. No additional permanent/production identities are defined.

## Expected checks

1. Refuse unsafe database identity, unexpected source hashes or missing
   disposable marker before opening application/database test sessions.
2. Deny ordinary application access to cleanup, direct deletion and role
   switching. Deny direct deletion by the test maintainer. Deny cleanup
   execution by the fixture role.
3. Start a cleanup transaction, remove 1 expired row from each table, and
   roll back; verify both rows remain; then commit authorized cleanup.
4. Renew an expired network bucket with the real network quota function
   and renew an expired agent bucket through real authenticated ingestion,
   while holding both update transactions open. Cleanup must skip these
   locked rows, remove unrelated old rows promptly, and preserve the now
   active buckets after their transactions commit.
5. Reverse the lock ordering: cleanup deletes the two expired quota buckets
   inside an uncommitted transaction, and real consumers try to update those
   same buckets. Confirm the consumers wait, then succeed after cleanup
   commits; no duplicate or permanently missing counters.
6. Lock a genuinely expired network bucket without updating it; confirm
   cleanup skips it promptly. After the lock is released, cleanup removes it.
7. Seed 525 synthetic expired buckets per table, start four independent
   maintenance sessions and concurrently submit **80 actual authenticated
   telemetry records** as a distinct agent. Verify exactly 525 network and
   525 agent rows removed in total, no individual cleanup batch over 250,
   all 80 submissions inserted, current agent quota remains active and shows
   80 attempts, and no older buckets remain.
8. Verify **327 telemetry sample and submission rows** remain (244 prior
   rehearsal fixtures, three new real-credential submissions during lock
   scenarios and 80 concurrent submissions), the immutable migration
   receipts are intact, and the original D15B security permission gate passes.
9. Remove all synthetic data and test-only PostgreSQL roles with the guarded
   disposable cluster shutdown.

**Important:** A successful run proves only the tested local race conditions,
not worst-case load, real production peer/Nginx trust, distributed worker
scheduling, failover, PITR, offsite recovery, or approval to enable cleanup.

## Install

Extract the ZIP **from the project root**. All files are NEW. The package
must not overwrite an existing locked SQL migration.

```bash
cd ~/Projects/pulse-metrics
unzip -l ~/Downloads/pulse-metrics-d15c5b-quota-contention-rehearsal.zip
unzip -n ~/Downloads/pulse-metrics-d15c5b-quota-contention-rehearsal.zip
```

## Static checks

```bash
cd ~/Projects/pulse-metrics
node scripts/telemetry-maintenance/verify-contention-candidate.mjs
node scripts/telemetry-maintenance/verify-candidate.mjs
bash -n scripts/test-telemetry-quota-contention-rehearsal.sh
node --check scripts/telemetry-maintenance/retention-contention-integration.mjs
git status -sb
```

## Disposable PostgreSQL stress test

```bash
cd ~/Projects/pulse-metrics
bash scripts/test-telemetry-quota-contention-rehearsal.sh
```

The complete D15C-5A replay is intentionally repeated first. This is slower
than a mock unit test but tests the real PostgreSQL locking and access control
mechanisms. The expected final marker is:

```
D15C-5B DISPOSABLE CONTENTION REHEARSAL: ALL CHECKS PASSED
PUBLIC LAUNCH: NO_GO | temporary peer-auth roles only; no scheduler or public endpoint
PASS: disposable quota PostgreSQL cluster removed
```

If ANY assertion or timeout fails, do not modify production grants, do not
install migrations manually, and do not commit this candidate. Preserve the
non-secret terminal error summary for review. Never share real DB passwords,
enrollment tokens, or machine credentials.

**Next security steps:** independently review maintenance authentication,
lock timeout monitoring, maintenance scheduling and alerting, audited retention
configuration, release provenance, offsite PITR, and staged rollout gates.
