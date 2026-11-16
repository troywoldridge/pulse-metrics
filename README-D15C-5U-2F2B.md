# Pulse Metrics — D15C-5U-2F2B: Retained local cold snapshot

**Status:** new guarded candidate; **not executed against the user's PostgreSQL cluster**. Public launch **NO-GO**.

## Why this milestone exists

The D15C-5U-2E2A rehearsal demonstrated that a temporary physical copy of the stopped persistent development PostgreSQL cluster could be started twice and audited, but the rehearsal intentionally removed that copy afterward. Before pilot telemetry changes persistent developer data, a retained local copy is a sensible recovery prerequisite. This is **not** permission to begin persistent writes, enrollment or to change PostgreSQL startup modes.

The script `scripts/telemetry-persistent/retained-local-cold-snapshot.sh` provides a **single retained byte-verified, owner-only copy** of the existing quarantined PostgreSQL 16 development data directory, which must already be stopped. It never accesses the original `pulse_metrics` database, starts a PostgreSQL server, changes schemas, creates a ready marker, or provisions any identities.

## Locations and safe behavior

| Purpose | Exact location |
|---|---|
| Source | `/var/lib/postgresql/pulse-metrics-dev-5u2/data` |
| Retained local copy | `/var/lib/postgresql/pulse-metrics-dev-5u2-cold-backup-5u2f2b/data` |
| Snapshot metadata | `/var/lib/postgresql/pulse-metrics-dev-5u2-cold-backup-5u2f2b/snapshot.meta` |

The copy is located **on the same host**, likely on the same storage device. It is neither off-machine nor disaster-resilient. There is no scheduling, no rotation, no backup encryption proof and no point-in-time recovery (PITR). Retained backups can contain sensitive data even if this development cluster is currently empty, so every backup directory is `postgres`-owned and mode `0700`; marker and manifest files are mode `0600`.

The backup is created only if the fixed destination does not already exist and an exact per-invocation approval is supplied. It refuses links, external tablespaces, abnormal file types, a running or unclean source, source over 1 GiB or inadequate free space. It verifies each copied file using a deterministic path-and-content digest and sums ordinary file bytes independently. A failed attempt is left marked **incomplete** for manual investigation; **never delete or repair it automatically**. Re-running `--create` cannot overwrite the destination. Successful copies receive a separate verified marker. `--verify` checks the retained copy against its stored digest without modifying it.

A hash kept beside the copy detects accidental corruption but does **not** provide independent protection against someone able to modify both snapshot and manifest.

## Run modes

- `--plan`: read-only stopped-source inspection and plan, no backup created.
- `--create`: requires `PULSE_APPROVE_5U2F2B_RETAINED_BACKUP=ONE_STOPPED_LOCAL_COPY`; creates the one retained copy only.
- `--verify`: read-only recheck of saved snapshot digest, file count and clean shutdown state. Source must still be stopped.

Do not run the old `scripts/telemetry-dev/manage-persistent-development.sh`, create `.pulse-5u2-ready`, open a telemetry HTTP route or run migrations for this milestone.

## Before a persistent telemetry pilot

The follow-up gate should (1) restore **this retained copy** to an isolated destination and test PostgreSQL startup/security without touching the source, (2) implement explicit developer-only fixture lifecycle and approval, (3) confirm runtime machine-credential enrollment and history authorization on the dedicated cluster, (4) schedule encrypted/offsite backups and recovery exercises before production, and (5) keep all customer/public APIs disabled until a separate launch review.

## Offline verification performed during package creation

Bash syntax passed and all nine offline tests passed. Those tests exercise refusals and contract invariants; they do **not** prove the retained backup operation on Troy's machine. Do not call this milestone complete until `--create` and `--verify` both pass against the exact stopped cluster.

If any command refuses or a backup directory is marked incomplete, **stop and share the exact output**. Do not manually remove, chmod, rename, restart or modify any PostgreSQL directories.
