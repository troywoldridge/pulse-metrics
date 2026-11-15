# Pulse Metrics — D15C-5U-2E2: Cold physical backup/restore verification

**Document status:** Development-only candidate. **Public launch: NO-GO.**

## Starting state

Requires D15C-5U-2E1 to have passed. The existing **quarantined** persistent cluster must be stopped cleanly and contain the completed migration foundation. The original development database stays unchanged. No readiness marker is created.

## Purpose and limits

This is a bounded **cold physical backup rehearsal**, not a production backup configuration:

1. Verify the quarantined source cluster is shut down, has TCP disabled, and has the pinned original-database fingerprint.
2. Refuse nonstandard tablespaces, symlinks/unsupported data files, and source data larger than 1 GiB; require at least 3 times the source size available under `/tmp`.
3. Make a separate, 0700, `postgres`-owned temporary physical copy at `/tmp/pulse-restore-5u2-XXXXXXXXXX`.
4. Compare SHA-256 manifests for every source and copied file **before starting the copy**.
5. Start **only the copied cluster** on its own Unix socket and port **55434**, with **TCP disabled**. The source remains stopped on port 55433.
6. Read-only SQL audits verify migration receipts, restricted application privileges, FORCE RLS, privileged function ownership, and zero operational rows. A restricted-role read of the private credential table must fail with permission denial.
7. Stop and restart the restored copy and repeat audits; verify the migration receipt fingerprint is stable across the restart.
8. Shut down and remove **only** the marker-verified temporary restore directory. Recheck the stopped original cluster and the original development database fingerprint.

The script never writes SQL, changes original migration scripts, creates agents, or activates HTTP/API routes. The temporary restored PostgreSQL server writes **only into its copied data files** and its private log. On unexpected cleanup failure, it refuses success and leaves the private directory for manual investigation.

**No backup is retained.** This is not point-in-time recovery (PITR), encrypted/off-site backup, disaster recovery, or live backup validation. Those are separate future deployment requirements. Do not run this against any database containing customer data.

## Run order

Install the package only if all three target paths are absent. Verify the downloadable archive SHA-256 from the accompanying instructions. Review both complete scripts before execution.

### Read-only plan

```bash
cd ~/Projects/pulse-metrics
env -u NODE_OPTIONS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/verify-cold-backup-restore.sh --plan
```

Plan mode checks the source's offline invariants but does not create a copy or start PostgreSQL.

### Explicitly approved isolated cold-restore rehearsal

```bash
cd ~/Projects/pulse-metrics
env -u NODE_OPTIONS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  PULSE_APPROVE_5U2E2_COLD_RESTORE=TEMPORARY_COPY_ONLY \
  bash scripts/telemetry-persistent/verify-cold-backup-restore.sh --verify
```

This **does** create and delete a private temporary copy, and start and stop PostgreSQL **inside that copy**, but it does **not** start or modify the original source cluster.

**Do not rerun automatically after any failure.** Report the exact output, especially any `CRITICAL` cleanup warning. Do not use `--apply` or `--resume` on the original persistent cluster. All public monitoring remains disabled.

## Offline tests

```bash
node --test scripts/telemetry-persistent/verify-cold-backup-restore.test.mjs
bash -n scripts/telemetry-persistent/verify-cold-backup-restore.sh
```

The tests check command refusal, fixed target locations, deletion boundaries, backup-copy verification, and safety assertions. Real PostgreSQL backup/restore success is established only by a successful `--verify` run on `adap`.
