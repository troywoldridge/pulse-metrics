# Pulse Metrics — D15C-5M Real PostgreSQL Historical Isolation Rehearsal

**Date:** 2026-11-14

**Status:** Disposable real-database integration candidate; NOT deployed or production-approved.

**Reviewed baseline:** `feat/identity-organization-onboarding` after D15C-5L commit `d75fa860ae5defa7842e7481a9249279112c1746`.

**PUBLIC LAUNCH: NO_GO**

## Why this milestone exists

D15C-5L implemented an unmounted, read-only history service and an authenticated route candidate. Its unit and HTTP tests could not prove that the real PostgreSQL restricted runtime role, RLS policies, migration functions, connection pool, and actual telemetry queries operate together. D15C-5M addresses that missing evidence without enabling a monitoring endpoint.

The test runs in a **completely fresh PostgreSQL cluster** under a random `/tmp/pulse-replay-XXXXXXXXXX` directory. PostgreSQL is configured to accept **Unix-socket connections only** (`listen_addresses=''`), with no TCP listener. The service under test uses `pulse_metrics_app`, a separate non-superuser, non-BYPASSRLS role. Schema and identity functions are installed by replaying the original pinned project migrations and their approved privileged steps. The script never uses the development `.env` database URL or the already-running PostgreSQL cluster for a connection.

## Five complete new files

1. `README-D15C-5M.md`: instructions, limitations and acceptance criteria.
2. `scripts/monitoring-history/fixtures-5m.sql`: fictional A/B organizations, users, agents, timestamped history, unavailable values, out-of-range rows and 501 bounded rows; exclusively for the disposable cluster.
3. `tests/integration/monitoring-history-postgres.integration.test.ts`: real 5L service and local HTTP route tests against the restricted database identity; a synthetic WorkOS verifier is injected **only** for localhost test traffic.
4. `scripts/test-monitoring-history-postgres.sh`: guarded, fresh-cluster creation, schema replay, two test phases, membership revocation and marked cleanup; does **not** modify `server.ts`.
5. `scripts/monitoring-history/verify-5m-candidate.mjs`: SHA-256 checks for all other new files, monitoring hold and baseline dependency checks, without database access.

All files are new; no existing project source needs to be overwritten. No network administration, `work` server change, PM2 change, Cloudflare configuration, customer credential, live app route mount or external provider operation is part of this package.

## Safety contract

- The runner refuses `NODE_ENV=production`, unexpected arguments, and missing dependencies.
- It clears external libpq routing variables and ignores the pre-existing `DATABASE_URL`.
- The temporary cluster is created under the `postgres` OS account, on its own random directory and socket; TCP is turned off.
- Before any fixture is installed, the wrapper verifies the *exact data directory*, administrator identity, socket address and absence of TCP listening.
- The original pinned Drizzle migration and all six privileged SQL scripts run under the existing reviewed fresh-replay procedure, not against a working database.
- The wrapper creates a test-only `DATABASE_URL` using its random socket and forces `DATABASE_POOL_MAX=1`.
- The marked cluster is stopped and recursively deleted only after the runner confirms the exact temporary pathname and its private marker. If the server remains alive, it is **not** deleted.
- The private test server listens only on `127.0.0.1` and uses a fake identity verifier, which does **not** test real WorkOS JWT verification.
- The existing real server continues to reject monitoring endpoints. The new route remains unmounted.

## Required tests

The initial phase must prove, using the real restricted PostgreSQL role:

- Current role is `pulse_metrics_app`, on the isolated local Unix socket.
- It is not superuser, does not have BYPASSRLS, and cannot read secret credential tables or update/delete telemetry.
- No tenant context means no agent or telemetry rows are returned.
- Organization A can read A's real stored CPU/memory/disk history, with genuine nulls and without invented network rates or raw JSON.
- Organization B can read B's different history; neither user can read the other organization.
- A foreign agent ID within A's organization is denied as not found, matching a nonexistent agent ID.
- The empty-history agent returns empty points, not a healthy/green status.
- A's historical points outside the requested time window are excluded.
- Of 501 in-range values, the latest 500 are returned oldest-first and `truncated=true`.
- The actual Express route with a synthetic verifier emits expected 200/400/401/403/404 statuses without leaking tenant data.
- A single pooled PostgreSQL backend is reused and the transaction-scoped tenant variables do not persist.

The revocation phase deletes **only an invented fixture membership inside the disposable cluster**, then proves A is denied and B still reads normally. The wrapper must remove its own cluster on success or failure.

## Run on the development PC (`adap`) only

Save the ZIP in Downloads and run from the checked-out repository root:

```bash
cd ~/Projects/pulse-metrics

git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5m-real-postgres-history.zip
unzip -o ~/Downloads/pulse-metrics-d15c5m-real-postgres-history.zip

bash -n scripts/test-monitoring-history-postgres.sh
node scripts/monitoring-history/verify-5m-candidate.mjs
bash scripts/test-monitoring-history-postgres.sh

npm run lint && npm test && npm run build && git diff --check && git status -sb
```

The integration runner requires the local PostgreSQL server binaries (`pg_config`, `initdb`, `pg_ctl`, `psql`, `createdb`), `sudo` authorization for the `postgres` OS account, Node.js, and the project's installed `node_modules`. It does **not** connect to your server at `work` and does **not** need the SSH tunnel. If prerequisites or the replay baseline differ, the runner must stop rather than substitute a live database.

The new integration test is under `tests/integration/` and must be run by the guarded script. It is **not** discovered by the regular `npm test` runner, which searches `src/` only.

Expected success footer:

```text
========== D15C-5M REAL POSTGRESQL HISTORY: BOTH PHASES PASSED ==========
PUBLIC LAUNCH: NO_GO | no production monitoring route mounted
PASS: isolated 5M database cluster removed
```

## What passing means — and what it does not

A passing 5M test demonstrates the specifically enumerated paths above on a fresh disposable PostgreSQL cluster, against the real 5L service and restricted runtime role. It does **not** prove that the database is hardened against arbitrary SQL execution by a compromised application role: the application controls transaction-local custom PostgreSQL settings, so SQL injection and maintenance of the trusted application boundary remain important. It does not test live WorkOS JWTs, real agents delivering over HTTPS, reverse proxy security, customer subscription limits, high availability, offsite backups, distributed retention, or public deployment.

**No historical dashboard connection or customer API mount is authorized by 5M alone.** The subsequent implementation can evaluate integrating a read-only, tenant-authorized history route under the complete production ingress policy and surfacing actual values in a React view with honest unavailable/stale states. External security and release gates remain unverified.

**PUBLIC LAUNCH: NO_GO**
