# Pulse Metrics — D15C-5U-2E2A: owner-only path guard correction

**Status:** Local, isolated backup-rehearsal fix. **Public launch: NO-GO.**

## Failure observed

During D15C-5U-2E2 `--verify`, the original safety check stopped after the offline cluster verification:

`REFUSE_D15C5U2E2: Tablespace directory missing or linked`

The script was running as a non-root operator. PostgreSQL's data directory is `postgres`-owned with private access (0700), so Bash's `[[ -d "$SOURCE_DATA/pg_tblspc" ]]` tested as the caller can return false even for a real and safe directory. The same mistake affected restore marker checks, running/stopped status checks, and absent `postmaster.pid` checks under a private temporary restore directory. The backup did not begin at the observed failure point.

## Correction

- Replace the **entire** `verify-cold-backup-restore.sh` and the **entire** matching test file.
- Check paths below owner-only PostgreSQL directories as `postgres`, through explicit directory/file/absence helpers; retain symlink rejections.
- Keep exact stopped source, dedicated Unix socket/port 55434 for the restored copy, 1 GiB source limit, 3× space guard, SHA-256 copy comparison, real restricted-role audits, two restored PostgreSQL restart cycles, and cleanup verification.
- Do not change the original PostgreSQL cluster's permissions, migration SQL, persistent cluster or ready marker.

## Boundaries

The script may only operate on the original, stopped `/var/lib/postgresql/pulse-metrics-dev-5u2/data` cluster and a newly generated isolated `/tmp/pulse-restore-5u2-XXXXXXXXXX` sandbox. It must not be run against customer data. It does not provide a retained backup, off-site copy, PITR, or launch authorization.

## Install and test

Verify the **original** script SHA-256 before copying any files:

`f142bea301edbcc7ec62c2b217335c2d35b87856e12f3148f6e518b7c7bb44a8`

New complete replacement hashes:

- `verify-cold-backup-restore.sh`: `3d18ca8704ac1a936380793acfa5dbe2c503032d339c9d3b11f37ead77122bd1`
- `verify-cold-backup-restore.test.mjs`: `4492118df6abc7196215cc69f8019e4a8a08c9557d37b967b3563d43af5825ac`

After replacing the complete files, use:

```bash
bash -n scripts/telemetry-persistent/verify-cold-backup-restore.sh
node --test scripts/telemetry-persistent/verify-cold-backup-restore.test.mjs
bash scripts/telemetry-persistent/verify-cold-backup-restore.sh --plan
```

Once the plan succeeds, the explicit temporary-copy test command is:

```bash
env -u NODE_OPTIONS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  PULSE_APPROVE_5U2E2_COLD_RESTORE=TEMPORARY_COPY_ONLY \
  bash scripts/telemetry-persistent/verify-cold-backup-restore.sh --verify
```

The `--verify` command creates/starts/stops/deletes **only the temporary restored copy**. If any failure occurs, **do not automatically rerun**; report the full output and any `CRITICAL` cleanup message before modifying anything. Never apply pending migrations or start the original cluster to work around this guard.
