# Pulse Metrics — D15C-5D Maintenance Audit Evidence and Alert Candidates

**Status: REVIEW ONLY — test-only Unix socket and disposable PostgreSQL cluster.**  
**Commercial public launch: NO_GO.**  
**Source checkpoint:** D15C-5C commit `e9dcc29`, branch `feat/identity-organization-onboarding`.

## Scope

This package creates **seven NEW files** and does not overwrite any existing
project file, change a pinned migration, add an application grant, launch a
scheduler, expose an HTTP endpoint, provision an operator identity, send email,
or configure a webhook. It repeats the previously verified D15C-5C disposable
PostgreSQL rehearsal, then tests the real D15C-5C controller with a separate
**local file audit journal and machine-readable alert candidates**.

The purpose of D15C-5D is to prove *recording, classification and failure safety*,
not actual production alert delivery or operational durability.

### Added files

1. `README-D15C-5D.md` (this documentation)
2. `scripts/telemetry-maintenance/maintenance-audit-policy.mjs`
3. `scripts/telemetry-maintenance/maintenance-audit-cli.mjs`
4. `scripts/telemetry-maintenance/maintenance-audit.test.mjs`
5. `scripts/telemetry-maintenance/maintenance-audit.integration.mjs`
6. `scripts/telemetry-maintenance/verify-audit-candidate.mjs`
7. `scripts/test-telemetry-audit-alert-rehearsal.sh`

## Security properties

- An independently guarded CLI accepts **no arguments or DATABASE_URL**; its
  only database target is the approved disposable `/tmp/pulse-replay-XXXXXXXXXX`
  Unix-socket cluster on port `55432`. TCP is disabled. It refuses production
  mode, PostgreSQL environment connection overrides, missing marker files,
  and untrusted journal directories. The prior D15C-5C controller also enforces
  its independent guards and PostgreSQL identity/role restrictions.
- A test-private `/tmp/pulse-maint-audit-XXXXXXXXXX` directory is owned by the
  invoking user with `0700` permissions. The audit journal and its marker are
  mode `0600`. Journal symlinks, invalid ownership, missing markers, and
  excessive size are rejected.
- The local JSONL journal has sequential, SHA-256 hash-linked records. Every
  append checks the complete existing chain, fsyncs the new record, and verifies
  it afterward. A private local run lock refuses overlapping audit writers.
  Stale run locks **fail closed** and must be reviewed, never silently stolen.
- Controller output is limited to the **exact approved D15C-5C protocol**.
  Unexpected status codes, counts, extra fields, raw stderr, partial output,
  incorrect summary totals or abnormal exit produce `maintenance_protocol_invalid`
  rather than copying raw output into the journal.
- The audit records include only generated run ID, UTC timestamp, monotonic
  sequence, sanitized status, bounded counters, alert classification and prior
  record hash. **No DB credentials, socket paths, tenant identifiers, SQL,
  machine credentials, network digests or customer telemetry** are recorded.
- The CLI emits `D15C5D_ALERT { ... }` to stdout on warning or critical
  outcomes. These are LOCAL machine-readable alert candidates. **They are not
  delivered or acknowledged.** No SMTP, webhook, email, pager, or external
  service exists yet. Failure to store the audit record is a nonzero result;
  no success marker is emitted after journal failure.
- The journal is NOT immutable, independently anchored or production-durable:
  the same filesystem user can modify and rehash it, the whole file may be
  removed, crash consistency is limited to the local file, and the disposable
  rehearsal deliberately removes it. Future work needs an external,
  permission-separated audit sink, backup/retention policy, monitoring and
  confirmed alert acknowledgments.

### Event classifications

| Source event | Audit status | Local alert candidate |
|---|---|---|
| Maintenance completed normally | `completed` | None |
| Maintenance completed after 3 nonempty batches | `completed` | `maintenance_possible_backlog` (warning) |
| Advisory lock already held | `overlap_skipped` | None for one occurrence |
| Maintenance function permission failure | `failed` | `maintenance_operation_failed` (critical) |
| Malformed/incomplete controller protocol | `invalid_output` | `maintenance_protocol_invalid` (critical) |
| Unsafe wrapper configuration | Refused before DB | No journal written; CLI returns failure |
| Journal tampered or locked | Refused before DB | No further maintenance; CLI returns failure |

The backlog flag is conservative, not a measured queue length. A zero-result
batch is not proof of no backlog under concurrent row locks. Repeated overlap,
alert thresholds, SLAs and actual notifications require later review.

## Included tests

Unit tests verify allowed protocol shapes and totals, exact privilege-safe
failures, warning classification, unsafe stderr rejection, append-only chain,
file mode, tamper/incomplete-tail denial, symlink denial and writer lock.

Real disposable PostgreSQL integration then exercises:

1. Unsafe configuration refuses before connecting; no journal appears.
2. A no-work maintenance run creates a hashed audit entry without warning.
3. 770 expired synthetic buckets in each quota table; a bounded run removes
   750+750, records the outcome and emits a **local backlog warning**.
4. A second bounded run removes the remaining 20+20; current/recent buckets
   and all 327 previous synthetic telemetry samples remain preserved.
5. An independently held real advisory lock produces an audit record for
   `overlap_skipped`, but no false failure alert.
6. A real `REVOKE EXECUTE` against the **temporary test-only maintenance
   identity** causes a nonzero controller result and a critical alert record;
   the grant is restored afterward by the privileged disposable launcher.
7. A modified prior audit record causes fail-closed refusal before cleanup.
8. Read-only PostgreSQL checks verify protected telemetry data and application
   permissions remain unchanged, and the test trap removes both the private
   audit directory and isolated PostgreSQL cluster.

## Install — only from the project root

```bash
cd ~/Projects/pulse-metrics
unzip -l ~/Downloads/pulse-metrics-d15c5d-maintenance-audit-review.zip
unzip -n ~/Downloads/pulse-metrics-d15c5d-maintenance-audit-review.zip
```

All seven files must be **new**. Do not overwrite committed files or protected
migrations. Keep the eight older untracked diagnostic README files separate.

## Static and application verification

```bash
cd ~/Projects/pulse-metrics
node scripts/telemetry-maintenance/verify-candidate.mjs
node scripts/telemetry-maintenance/verify-contention-candidate.mjs
node scripts/telemetry-maintenance/verify-operations-candidate.mjs
node scripts/telemetry-maintenance/verify-audit-candidate.mjs
node --test scripts/telemetry-maintenance/maintenance-audit.test.mjs
node --check scripts/telemetry-maintenance/maintenance-audit.integration.mjs
node --check scripts/telemetry-maintenance/maintenance-audit-cli.mjs
bash -n scripts/test-telemetry-audit-alert-rehearsal.sh
npm run lint
npm test
npm run build
```

## Real PostgreSQL rehearsal — **disposable workstation only**

```bash
cd ~/Projects/pulse-metrics
bash scripts/test-telemetry-audit-alert-rehearsal.sh
```

This test first replays *all previous* pinned migrations, HTTP integration and
D15C-5C operations tests in an isolated PostgreSQL cluster. It then performs
D15C-5D. It does **not** connect to the real development DB. Do not run the
individual CLI manually or set its disposable-only environment outside the
reviewed script.

**Expected markers only if all tests pass:**

```
PASS: D15C-5D unsafe configuration rejected before maintenance
PASS: audit journal recorded completed no-work run without alarm
PASS: 750+750 bounded cleanup recorded; local backlog warning emitted
PASS: drained residual quota without deleting active/recent records
PASS: overlapping controller produces audit receipt, not false alarm
PASS: private SHA-256 audit chain, counters and alert classifications verified
PASS: journal tampering blocks maintenance before DB access
PASS: real revoked function emits critical alert candidate and durable sanitized failure receipt
D15C-5D DISPOSABLE AUDIT/ALERT REHEARSAL: ALL CHECKS PASSED
PASS: disposable private audit journal removed
PASS: disposable quota PostgreSQL cluster removed
```

The package author verified Node and shell syntax, SHA-256 manifest alignment,
ZIP integrity, and the standalone policy unit tests. **Only a real disposable
PostgreSQL run on your development workstation can confirm integration.**
Do not commit until those results are inspected. Public launch remains NO_GO.

**Next milestone:** durable external audit storage and operational alert
routing/delivery with an approved separate operator identity, incident
retention/custody and independently verified staging deployment gates.
