# Pulse Metrics — D15C-5U-2B2 Retained Cluster SQL Inspection

**Status:** offline checks previously passed; this is **SQL inventory only**, not migration recovery approval.

## Why this is necessary

The first persistent installation stopped during the original Drizzle migration runner: PostgreSQL refused a restricted runtime role's attempt to inspect the privileged `data_directory` configuration setting. The preexisting 5U-2B1 offline check verified a clean shutdown, Unix socket configuration, and no change to the original database, but could not inspect SQL objects inside the new cluster.

The new script checks the actual schema and roles using **local administrator (`postgres`) SQL**. It only accepts the expected **bootstrap-only** state: two restricted roles, no Drizzle tables, no customer/tenant tables, no privileged migration receipts, and none of the candidate telemetry schemas. A mismatch fails closed, without running recovery.

## Safety boundary

- Exact persistent path: `/var/lib/postgresql/pulse-metrics-dev-5u2`
- Exact separate Unix socket: `/var/lib/postgresql/pulse-metrics-dev-5u2/socket`, PostgreSQL port `55433`; TCP disabled
- Requires the unchanged 5U-2B1 offline inspection script and its pinned checksum before starting
- Refuses production environment, inherited database URLs, pre-existing ready marker, running cluster, or unexpected filesystem ownership
- Starts only this incomplete cluster; startup changes PostgreSQL's own operational files, **but SQL statements use `BEGIN READ ONLY`**
- Explicitly verifies the exact server `data_directory` as the PostgreSQL administrator before inspecting the application database
- Does not migrate, seed, grant privileges, modify the original database, or install candidate code
- Uses an EXIT trap to stop the temporarily started cluster even when SQL inspections fail, then runs the original offline inspection again
- A failed shutdown still requires manual investigation. Never rerun the original `--apply` command.

## Expected result

`D15C-5U-2B2 RETAINED SQL INSPECTION: PASS`, followed by a mandatory stop and `D15C-5U-2B1 OFFLINE INSPECTION: PASS`.

Only after this output is reviewed should a **separate, explicit, controlled resume procedure** be prepared. The corrected full-file migrator in `candidate-replacements` must remain unused until then.

**PUBLIC LAUNCH: NO_GO.**
