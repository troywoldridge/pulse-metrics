# Pulse Metrics — D15C-3C disposable PostgreSQL quota rehearsal

**Status:** Unexecuted against PostgreSQL in the packaging environment. **Review before running.** This package contains exactly two NEW source files and does **not** contain or change the pinned D15C-3B SQL migration.

- `scripts/test-telemetry-network-quota-rehearsal.sh` — standalone temporary-cluster orchestrator
- `scripts/telemetry-quota/quota-integration.mjs` — restricted-role SQL, exhaustion, concurrency and rollover tests

## Scope

The runner verifies previously pinned historical migrations, D15B source, and D15C-3B source. It makes a fresh PostgreSQL cluster in a unique `/tmp/pulse-replay-XXXXXXXXXX` directory, binds **only a Unix socket** (TCP disabled), replays the existing database foundation, installs D15B in that isolated database, performs a forced-rollback test of D15C-3B, installs the D15C-3B candidate in the isolated database, tests duplicate migration rejection, tests quota behavior using the restricted `pulse_metrics_app` role, verifies that quota bucket expiry resets the counter, and attempts to stop/remove the temporary cluster on exit.

It contains a strict marker/path check before temporary directory deletion, and every `psql`/`createdb` command specifies the temporary socket and port. The real `.env` database URL is checked for a local development configuration but is **not used to connect**. It requires `sudo -u postgres` to create and control the temporary PostgreSQL instance. **No production or shared machine** usage is approved. Treat any nonzero exit, retained cluster warning, or unexpected SQL output as a failure. Never bypass a preflight guard just to get the test running.

## Installation

From the repository root, with the D15C-3B migration source package already installed:

```bash
unzip -n ~/Downloads/pulse-metrics-d15c3c-disposable-rehearsal.zip
bash -n scripts/test-telemetry-network-quota-rehearsal.sh
node --check scripts/telemetry-quota/quota-integration.mjs
node scripts/telemetry-quota/verify-candidate.mjs
```

After confirming the scripts and the isolated PostgreSQL environment, run:

```bash
bash scripts/test-telemetry-network-quota-rehearsal.sh
```

The SQL ceiling under test is provisional **1,200 network requests in a rolling 60-second bucket** per HMAC digest. It is not an authenticated agent quota. The existing TypeScript checker and public HTTP route are not mounted. This check does not establish customer-production readiness or DDoS protection.

## Expected tests

- Refuse unexpected migration source or database identity.
- Force an error before COMMIT and prove no quota schema/role remains.
- Install the reviewed candidate on the isolated socket only.
- Confirm `FORCE RLS`, private ledger, restricted role and `SECURITY DEFINER` function ownership.
- Refuse a second installation.
- Refuse ordinary app-role SELECT/INSERT/UPDATE/DELETE on protected buckets.
- Refuse malformed digests.
- Admit exactly 1,200 sequential requests, reject the 1,201st.
- Admit 1,200 of 1,224 simultaneous submitted requests and reject 24.
- Keep independently keyed network identifiers separate.
- Reset an expired window back to one request.
- Recheck D15B protected ingestion permissions and clean up the disposable cluster.

**PUBLIC LAUNCH: NO_GO.** Do not commit or deploy these two files until the local PostgreSQL test results and security behavior have been reviewed.
