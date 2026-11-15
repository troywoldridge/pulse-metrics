# Pulse Metrics — D15C-5U-2E1: Persistent database restart and security audit

**Status:** Test-only local candidate; not a release or authorization to monitor customers.

The dedicated PostgreSQL cluster `/var/lib/postgresql/pulse-metrics-dev-5u2`
was successfully migrated through D15C-5U-2D and intentionally remains
quarantined (no `.pulse-5u2-ready` file). Do not run the legacy `--apply` or
`--resume` commands and do not use the old lifecycle manager: that manager
requires a marker which is intentionally absent.

This package adds **new files only**:

- `scripts/telemetry-persistent/verify-persistent-foundation.sh`
- `scripts/telemetry-persistent/verify-persistent-foundation.test.mjs`
- `README-D15C-5U-2E1.md`

`--plan` checks pinned SQL candidate integrity, the OFFLINE checker, target
ownership, stopped state, local-only PostgreSQL settings, and the independent
original-database fingerprint. It does not start PostgreSQL.

`--verify` (requires explicit `PULSE_APPROVE_5U2E_READ_ONLY=YES`) starts the
separate cluster twice; confirms exact administrator connection identity;
checks migration receipts, RLS, private-table permissions, restricted database
roles, and zero operational records in read-only SQL; verifies that the
restricted application role can connect on the Unix socket but cannot read
credential rows; checks the existing
privileged ledger and ingestion release gate; compares migration receipt
fingerprints across restarts; and stops the cluster after each pass. PostgreSQL
creates normal startup/shutdown log and control-file changes, but this script
runs **no SQL writes, data fixtures or migrations**.

It refuses production, inherited database URLs, unexpected CLI options, changed
pinned verification sources, and an existing readiness marker. An EXIT trap
attempts mandatory shutdown on errors or signals. If shutdown fails, stop and
investigate; never use the database as an agent destination until it is verified.

This is NOT a backup/restore test, nor a full tenant-isolation exercise against
the persistent cluster. Those remain separate milestones. Do not activate
services or enroll agents. **PUBLIC LAUNCH: NO_GO.**
