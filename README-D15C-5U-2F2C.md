# Pulse Metrics — D15C-5U-2F2C: Retained Snapshot Restore Test

**Status:** candidate for a local-only restore rehearsal; the live restore must pass before marking this milestone complete.

## Why this exists

D15C-5U-2F2B created and independently verified a **retained, local, stopped-cluster** physical copy. An earlier D15C-5U-2E2A restore rehearsal used a *new copy of the source*, not this retained backup. This step tests recoverability from exactly the retained artifact.

## Source and permissions

- **Protected source:** `/var/lib/postgresql/pulse-metrics-dev-5u2/data`. Must be stopped and quarantined. Never starts or writes to it.
- **Retained backup:** `/var/lib/postgresql/pulse-metrics-dev-5u2-cold-backup-5u2f2b/data`. Must have a valid `.pulse-5u2f2b-verified` marker and manifest; never starts, deletes, overwrites, or writes to it.
- **Expected retained digest:** `e1348fcee176ff546ae08792379a381329445d982ad40d8bef411839661b3106` from Troy's 5U-2F2B verification output.
- **Disposal test target:** uniquely generated `/tmp/pulse-retained-restore-5u2-XXXXXXXXXX`, owned by `postgres` and mode 0700. It has a distinct socket and PostgreSQL port `55435`; TCP and SSL are both disabled in the test process (TLS is not necessary for local Unix socket SQL checks).
- **Launch gating:** must use `--verify` plus `PULSE_APPROVE_5U2F2C_RETAINED_RESTORE=COPY_RETAINED_SNAPSHOT_ONLY`. `--plan` is read-only and requires no approval.
- Refuses production mode, inherited database URLs, Node injection and public telemetry flags.

## Test sequence

1. Verify pinned source inspection and backup-verification tools, stopped source identity, and retained snapshot checksum.
2. Refuse linked tablespace/WAL paths and unsupported file types; bound temporary storage required.
3. Copy the **backup** into a unique temporary data directory as `postgres` without using reflinks.
4. Compute the same deterministic file-path/file-content SHA-256 tree digest used by the retained backup tool. Require exact digest match with original retained snapshot before any PostgreSQL start.
5. Start only the copied database on private port 55435 and verify actual `data_directory`, socket, no TCP and runtime role.
6. In read-only SQL transactions, check the migration receipts, FORCE RLS, role privileges, function ownership, and zero operational records; attempt a restricted runtime read of the credentials table and verify SQLSTATE 42501.
7. Cleanly stop and start the copied database again, repeat the audit, and compare exact migration receipt fingerprints.
8. Stop and remove only the cleanly stopped, marked temporary copy. Verify source and retained backup again.

A failed cleanup is a hard failure: the script **retains** the temporary directory for manual review. Do not manually remove postgres directories or alter the retained backup to retry.

## Install

Use the accompanying ZIP's exact checksum from the assistant's message. Check that the two target files and this README do not already exist. Unzip, verify individual checksums, run `bash -n`, run offline `node --test`, then `bash scripts/telemetry-persistent/verify-retained-cold-restore.sh --plan` with unsafe inherited Node/DB options removed.

## Live invocation (separate explicit approval)

```bash
env -u NODE_OPTIONS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  PULSE_APPROVE_5U2F2C_RETAINED_RESTORE=COPY_RETAINED_SNAPSHOT_ONLY \
  bash scripts/telemetry-persistent/verify-retained-cold-restore.sh --verify
```

Expected final marker: `D15C-5U-2F2C RETAINED BACKUP RESTORE TEST: PASS`. The source and retained backup remain stopped/unchanged. This is **not** offsite backup validation, point-in-time recovery, encryption or production authorization.

**PUBLIC LAUNCH: NO-GO.**
