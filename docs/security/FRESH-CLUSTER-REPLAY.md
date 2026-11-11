# Pulse Metrics — Phase 2E3C5B: isolated fresh-cluster replay

**Status: local, disposable replay test. Not an adopted production migration system.**

**Reviewed Git baseline:** `dbc00026c5f3820e04ff3eee4946d1b985b0e635` on `feat/identity-organization-onboarding`.

## Why use a whole temporary cluster?

The original administrator SQL scripts, numbered `001`–`006`, deliberately require
`current_database() = 'pulse_metrics'`, operate as PostgreSQL administrator, and
create cluster-wide `NOLOGIN BYPASSRLS` function-owner roles. Those restrictions
must not be removed. Running these scripts inside another database in the
**same** cluster would collide with the existing function-owner roles.

Instead, the wrapper initializes a **new, temporary PostgreSQL cluster** under
`/tmp/pulse-replay-XXXXXXXXXX` (owned by the `postgres` operating-system
account). Its only PostgreSQL listener is a Unix socket inside that directory.
`listen_addresses=''` disables TCP entirely. Authentication uses **OS peer**;
`postgres` may administer the cluster, and the invoking OS user is mapped only
to the disposable `pulse_metrics_migrator` and `pulse_metrics_app` roles.
The directories are traversable only by the invoking user's Unix group and
`postgres` (not the general public). The temporary database is also called
`pulse_metrics`, deliberately satisfying the original SQL safety guards
**without altering their source code**.

## What it verifies

1. Refuses a nonlocal, production, or non-runtime `.env` configuration.
2. Compares the eight existing migration/admin source hashes against the
   recorded local baseline; refuses source drift.
3. Reads only the existing local database PostgreSQL version to select the
   matching server binaries; does **not** run DDL against the existing cluster.
4. Creates fresh isolated migrator and runtime database roles, database,
   schema privileges, and default privileges based on `docs/database-foundation.md`.
5. Calls the **real Drizzle ORM migrator**, producing a genuine new
   `public.__drizzle_migrations` record (not a manually inserted ledger row).
6. Grants the reviewed ordinary runtime privileges and applies the **six
   unmodified administrator SQL files** in order, inside the isolated cluster.
7. Runs `scripts/audit/migration-security-invariants.sql` against the fresh
   cluster, verifying ten FORCE RLS tables and six SECURITY DEFINER functions.
8. Tests runtime denial for direct counter-table SELECT and CREATE TABLE.
9. Compares deterministic structural catalog manifests from the existing
   database and fresh replay: tables, columns/defaults, constraints, indexes,
   RLS policy expressions, function definitions/owners/settings, relevant role
   attributes, and application table/function access. The current database
   is read only for this comparison; **no customer table rows are read**.
10. Stops and removes the temporary cluster, roles, socket and data files,
    including on a failed test. If shutdown cannot be verified, it retains the
    isolated files and prints an explicit cleanup warning.

This **does not** yet create or adopt new Drizzle migration entries for
`001`–`006`. Passing means the current reviewed SQL source can recreate the
observed *tested structural baseline* in a clean isolated PostgreSQL 16
cluster. It does not certify full production release, recovery planning,
provider-managed PostgreSQL compatibility, live WorkOS, or external ingress.

## Prerequisites

- Run from `~/Projects/pulse-metrics` on your trusted local Linux developer host.
- Original working tree clean at commit `dbc00026` before installing this package.
- PostgreSQL server binaries matching the existing PostgreSQL major version,
  with `pg_config`, `initdb`, `pg_ctl`, `createdb`, `psql`, `sudo`, and Node 22.
- Current local PostgreSQL `pulse_metrics` database; sudo ability to execute
  commands as the `postgres` OS user.
- No production data, networking, credentials or external targets are used.

## Run the test

```bash
cd ~/Projects/pulse-metrics
set +e
bash scripts/test-fresh-cluster-replay.sh
RESULT=$?
echo "Fresh-cluster replay exit code: $RESULT"
git status --short
```

Review the entire wrapper before running it: the script uses `sudo` to create
and remove an isolated directory under `/tmp`. It has strict path, marker,
transport and shutdown checks. **Do not copy only selected SQL commands or
redirect them to the existing PostgreSQL port.**

## Caveats / next increment

- Source checksum guard intentionally requires the exact reviewed original
  SQL. A changed migration requires a new audit and updated guarded package.
- Structural manifest parity covers enumerated catalog invariants, not all
  PostgreSQL permissions, extensions or configuration, and no data contents.
- No new migration history has been adopted for the six administrator steps.
  Phase 2E3C5C will design reviewed versioning and a non-destructive adoption
  strategy for existing deployments.
- No public proxy, invitation redemption, SSH, fabricated telemetry or WebSocket
  feature is enabled by this test.
