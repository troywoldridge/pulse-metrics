# Pulse Metrics — D15C-5A bounded telemetry quota retention

**Status: REVIEW ONLY — disposable PostgreSQL rehearsal only.**
**Commercial release status: NO_GO.**

## Purpose

The committed D15C-3 network and D15C-4 agent quotas correctly record
`window_end`, but have no approved cleanup mechanism. This package proposes a
private, fixed-policy retention function without modifying any existing
fingerprint-locked SQL migration or activating a scheduler or HTTP endpoint.

The PostgreSQL maintenance function removes only quota bucket rows whose
`window_end` is **more than 48 hours in the past**. This is a **48-hour grace
period after the quota window ends**, not a blanket deletion of all telemetry
older than 48 hours.

Each call removes a maximum of 250 expired network quota buckets and 250 expired
agent quota buckets. Rows in the active window, recently expired rows, telemetry
samples, submission receipts and tenant records are untouched. When more than
250 old rows exist in a table, the next manually authorized call handles the
next batch. The function uses `FOR UPDATE SKIP LOCKED` to avoid waiting on
active quota updates and rechecks expiry before deletion.

## Security boundary

- `pulse_telemetry_maintenance` is a private schema with a forced-RLS receipt.
- `pulse_metrics_telemetry_maintenance_executor` is a dedicated NOLOGIN,
  NOINHERIT, BYPASSRLS role with only the quota-table privileges needed by
  its function; **it is not granted to the runtime application role**.
- The maintenance executor holds `SELECT` for key/expiry columns, `DELETE`,
  and **column-level `UPDATE(window_end)`**. PostgreSQL requires `UPDATE` on
  at least one column for `SELECT ... FOR UPDATE`; this privilege is held only
  by the unloginable function owner and is not exposed to the app.
- `prune_expired_quota_buckets()` is `SECURITY DEFINER`, with a pinned search
  path. PUBLIC and `pulse_metrics_app` have no EXECUTE or schema USAGE.
- Only the PostgreSQL superuser may invoke the review-only function in the
  disposable rehearsal. There is no real operator account, schedule, cron,
  production command, or deployment approval in this package.
- The migration actively refuses a normal development or production database,
  validates prior migration receipts/ingestion-function fingerprint and fails
  closed on unexpected grants, roles, or security metadata.
- The function uses the server clock and hardcoded thresholds. The caller
  cannot pick a tenant, agent, network key, cutoff, or batch size.

## Files (all NEW; no existing file replacements)

1. `scripts/telemetry-maintenance/migrations/0001_telemetry_quota_retention.sql`
2. `scripts/telemetry-maintenance/migrations/manifest.json`
3. `scripts/telemetry-maintenance/verify-candidate.mjs`
4. `scripts/telemetry-maintenance/retention-runtime-negative.mjs`
5. `scripts/test-telemetry-quota-retention-rehearsal.sh`
6. `README-D15C-5A.md`

Pinned SQL SHA-256:

`5c8626cea57c4238698882b7260112cea1adfe017866af39ba14a2ffb39ddc5e`

## Safe local checks

```bash
cd ~/Projects/pulse-metrics
bash -n scripts/test-telemetry-quota-retention-rehearsal.sh
node --check scripts/telemetry-maintenance/verify-candidate.mjs
node --check scripts/telemetry-maintenance/retention-runtime-negative.mjs
node scripts/telemetry-maintenance/verify-candidate.mjs
npm run lint
npm test
npm run build
```

**Then, only on the project development workstation with its existing local-only
`.env` and an available `postgres` OS account:**

```bash
bash scripts/test-telemetry-quota-retention-rehearsal.sh
```

The new runner contains the complete pinned D15C-4E disposable bootstrap,
integration and cleanup sequence, with additional D15C-5A checks. It generates
an independent PostgreSQL cluster in `/tmp` with TCP disabled; verifies its
actual data directory and socket; replays the protected migrations; verifies
forced rollback and replay rejection; installs the candidate **only inside the
temporary cluster**; verifies runtime access is denied; inserts synthetic
expired and active quotas; verifies batches 250/250, 15/15 and 0/0; ensures
active and recently expired records survive; and checks the telemetry samples
and migration receipts remain unchanged. It removes the temporary cluster on
success and attempts cleanup on all failures.

**Do not manually execute the SQL migration. Do not enable a scheduled job.
Do not commit before reviewing the real PostgreSQL rehearsal output.**

## Not yet verified / future work

- The D15C-5A SQL itself has not been executed by the package author in
  PostgreSQL; the user must run the isolated rehearsal first.
- Concurrent cleanup-versus-ingestion lock-contention, operational scheduler
  identity, real audits, backoff, monitoring and alerts require independent
  review before production.
- The proposed 48-hour delay and 250+250 batch sizes are provisional;
  production requires measured workloads, shared-NAT fairness, privacy-policy
  alignment, separate scheduler authorization and an alert for growing backlog.
- Normal production deployment paths and operational backup/restore approval
  remain blocked.

**Pulse Metrics — Built to Last.**
