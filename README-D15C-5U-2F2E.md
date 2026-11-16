# Pulse Metrics — D15C-5U-2F2E: Genuine telemetry durability across disposable PostgreSQL restart

**Status:** Offline review / 10 tests passed. The actual Linux disposable-PostgreSQL restart rehearsal has **NOT** run yet on the development workstation. **PUBLIC LAUNCH: NO-GO.**

## Objective

Prove that the existing verified D15C-5T chain (genuine Linux metrics → certificate-verified loopback HTTPS → restricted PostgreSQL ingestion → organization-bound history) retains the genuine samples, membership checks, credential revocation, and ordinary-runtime security restrictions across a real PostgreSQL **stop and restart**. The database is the same *disposable* test PostgreSQL cluster created under `/tmp/pulse-replay-XXXXXXXXXX`, **not** the quarantined persistent cluster on port 55433 and **not** the retained backup.

## Changes

1. Complete-file replacement: `scripts/telemetry-https/run-postgres-https-subtest.sh` (previous file checksum `ef3edbe186bf98888232da2d984da661917fb50bc2b860839b15957709a5bad2`). The existing fresh TLS certificate generation, HTTPS test runner, and test CA cleanup remain. After the HTTPS runner finishes and closes its DB pool, new checks verify the exact temporary PostgreSQL identity, execute a clean `pg_ctl stop`, restart the *same* disposable data directory, verify a different postmaster start time, and invoke the read-only post-restart audit. The pre-existing parent disposable rehearsal retains responsibility for guarded database cleanup. Failure must abort the entire rehearsal.
2. New `scripts/telemetry-https/verify-pilot-after-restart.mjs` reads the already-persisted genuine samples through the restricted app role. It resolves agent identities through transaction-scoped membership, requires agent A to remain **revoked** and agent B to remain **active**, reads only each tenant's own history via the existing `readDisposableTenantHistory`, refuses foreign actor / agent selectors, verifies ordinary app cannot read credential table, and checks that connection-pool RLS context did not leak. It writes no data and mounts no routes.
3. New `scripts/telemetry-https/pilot-restart-policy.mjs` validates disposable-only identity, exact sanitized fields, measured zero, nullable metrics and denial outputs. 10 matching offline tests are in `pilot-restart-policy.test.mjs`.

## Environment boundaries

- The new restart occurs **only** while the original fully disposable D15C-5T wrapper has created `/tmp/pulse-replay-[A-Za-z0-9]{10}` with matching `data`, `socket`, and agent-quota marker.
- PostgreSQL runs as `postgres` on a private Unix socket, port **55432**, with TCP listening disabled. The wrapper verifies both the server's actual data directory and start-time change using the administrative identity.
- The read-only audit connects only as **`pulse_metrics_app`**; its query shape is bound to synthetic actor/agent identities read from the disposable database. It cannot use inherited database URLs, host overrides, custom TLS settings or production mode.
- The test does **not** alter `server.ts`, original quota rehearsal, persistent Postgres tooling, source migrations, RLS policies, WorkOS routes, owner-only credential vault, public listeners or the backup. No persistent 55433 writes are permitted.
- Final global row counts must still match **246 samples / 246 submissions / 2 genuine Linux samples**, and the original D15C-5T post-test audit must still pass after the restart.
- This adds evidence for **restart durability in a disposable cluster**, not proof of a fully supported persistent-pilot operating lifecycle, machine deployment, offsite backup/PITR, or production readiness.

## Install and test

1. Verify the ZIP SHA-256 and existing complete runner SHA-256 before extraction.
2. Extract into new paths and run `node --test scripts/telemetry-https/pilot-restart-policy.test.mjs`. Check full replacement and both new JS files against the supplied SHA-256 values.
3. Replace the **entire** existing `scripts/telemetry-https/run-postgres-https-subtest.sh` with the new complete file; verify installed hash.
4. Confirm quarantined development PostgreSQL remains stopped using `bash scripts/telemetry-dev/inspect-incomplete-persistent-development.sh`.
5. Run `env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL bash scripts/test-telemetry-https-postgres-rehearsal.sh`. This may require `sudo`, but never requires customer credentials. Do not modify other files if it fails.
6. On full success, check `npm run lint`, `npm test`, `npm run build`, rerun offline inspector and review `git diff --check` / `git status -sb`.
7. Only after verifying the live output, optionally stage and commit the **four files in this package**, excluding legacy diagnostics and provisioning artifacts.

## Success criteria

Look for these *new* results, in addition to all pre-existing 5T results:

```text
========== D15C-5U-2F2E DISPOSABLE DATABASE RESTART ==========
PASS: exact disposable PostgreSQL 16 cluster restarted on original private socket, TCP disabled
PASS: genuine Linux telemetry and tenant-isolated history survived disposable PostgreSQL restart
PASS: revoked agent stayed revoked; restricted credential reads and session leakage denied
PASS: 246 durable samples and submissions, including two genuine Linux records, survived restart
```

Stop on any refusal, SQL error, failed restart, failed cleanup, unexpected row count or altered source hash. **Never manually delete PostgreSQL directories after a failed rehearsal**. Inspect the parent disposable cleanup message and report the error.
