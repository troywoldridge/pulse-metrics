# Pulse Metrics — D15C-5U-2B1 Failed-Install Inspection

Status: **offline inspection only — incomplete installation, no resume approval**

## Observed failure

The new persistent cluster reached `APPLY ORIGINAL DRIZZLE FOUNDATION` and
failed before invoking Drizzle's migration runner. The restricted role
`pulse_metrics_migrator` was asked for `current_setting('data_directory')`,
which PostgreSQL 16 restricts to `pg_read_all_settings` or similarly privileged
roles. This is an application check-placement bug, not evidence that PostgreSQL
or the migration permissions themselves are broken.

**Do not grant `pg_read_all_settings`, `pg_monitor`, `SUPERUSER`, or any other
additional privilege to `pulse_metrics_migrator`.** The administrator wrapper
in `provision-persistent-development.sh` already validates the exact
`data_directory` with the `postgres` role before calling the migrator.

The original `--apply` command must **never be rerun** against the retained
partially initialized cluster. Do not delete or reuse the directory.

## Contents

- `scripts/telemetry-dev/inspect-incomplete-persistent-development.sh`:
  new **offline** inspection. Verifies marker, owner/mode, clean stop, fixed
  socket-only config and main database catalog fingerprint. It neither starts
  a service nor connects to the incomplete cluster.
- `candidate-replacements/scripts/telemetry-dev/migrate-persistent-foundation.mjs`:
  complete corrected migrator **candidate**. It no longer queries PostgreSQL's
  restricted `data_directory` setting. Do not install this yet; a separate
  guarded resume operation must first check database state as local postgres.

## Inspect

Run the separate installation command supplied with this package; only the
new inspection script is installed into the repository, not the candidate
replacement. Do not commit either file until the cluster state is resolved.

Expected source SHA256 of the **original** installed migrator:

`3008eb8df0ff837e57a6fb779ff00f0234a96a27e24fc7008526c75969fc34c8`

Expected SHA256 of the full **corrected candidate**:

`8a92d8247bc3d680eba45c099c0d8482734427c76ef8d70523aa1ea4c34edb6f`

A successful offline inspection does **not** show whether Drizzle tables,
functions, roles, or migration receipts exist inside the stopped cluster. An
administrator-only, socket-verified SQL inventory is required before any
recovery, and only then may a narrowly scoped resume script be proposed.

PUBLIC LAUNCH: NO_GO. No public endpoint or customer agent enabled.
