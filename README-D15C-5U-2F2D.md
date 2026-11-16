# Pulse Metrics — D15C-5U-2F2D: Persistent Telemetry Pilot Preparation

**Status:** New local-only readiness candidate. Offline tests passed. Real target `--verify` and `--audit` must be run and assessed on the development host before closing this milestone.

## What this accomplishes

Previous completed rehearsals established: (a) the isolated HTTPS → PostgreSQL → tenant-scoped history path, (b) a retained same-host physical backup of the stopped persistent database, and (c) successful restore and security audits from a **temporary copy** of that retained backup. This milestone gates the *preparation* for first persistent operational data.

The currently reviewed `local-development-postgres.sh` requires **zero** organizations, agents, credentials, telemetry, and quota rows. That is intentional. It cannot be used as a production or persistent-data lifecycle tool **after the first operational write**. Do not disable or patch its zero-row assertion to make a pilot appear to pass.

The new `prepare-local-persistent-pilot.sh` has exactly three modes:

- `--plan`: print a no-access plan and remaining blocker. No sudo or database operation.
- `--verify`: verify eight exact, prior-reviewed source checksums (including the existing operator, source inspector, sender, history helper, migration verifier, retained backup and restore tools), confirm the expected repository branch, verify the locked migration candidates, audit the **stopped** cluster using the existing source inspector, and check the exact retained cold backup and its digest. Does not start PostgreSQL or write data.
- `--audit`: repeat all verification, then with **separate explicit approval** start only the dedicated PostgreSQL 16 cluster, execute the existing read-only security audits (`--start`, `--audit`, `--status`), perform a mandatory shutdown, and verify the retained snapshot again. PostgreSQL itself may update normal internal control/WAL files on startup, but the command does not create customer/agent/sample records or run migrations.

## Exact boundaries

- Repo: `$HOME/Projects/pulse-metrics`, expected branch `feat/identity-organization-onboarding`.
- Data: `/var/lib/postgresql/pulse-metrics-dev-5u2/data`; private Unix socket `/var/lib/postgresql/pulse-metrics-dev-5u2/socket`, port `55433`, no TCP.
- Source is *quarantined*, even if the live audit passes. No `.pulse-5u2-ready` marker may be created.
- Retained backup: `/var/lib/postgresql/pulse-metrics-dev-5u2-cold-backup-5u2f2b`, hash verified by the pinned 5U-2F2B tool. This is same-host only; no off-site backup, PITR, recovery timeline or encrypted remote retention is supplied.
- No HTTP service or WorkOS endpoint is mounted, no remote host connection is configured, and no developer/customer fixture is inserted.
- Fail closed for production mode, inherited database URLs, custom Node startup/TLS trust, public ingress switches, enabled one-shot sender, missing/mutated source files, wrong branch, and unsafe database state.
- For `--audit`, approval must be exactly `PULSE_APPROVE_5U2F2D_READ_ONLY_AUDIT=START_AUDIT_STOP_ZERO_ROWS`.
- The tool never uses `DATABASE_URL` or `MIGRATION_DATABASE_URL`. Do **not** pass secrets or credentials in shell arguments.

## Install

The companion ZIP contains only complete new files:

- `README-D15C-5U-2F2D.md`
- `scripts/telemetry-persistent/prepare-local-persistent-pilot.sh`
- `scripts/telemetry-persistent/prepare-local-persistent-pilot.test.mjs`

The install process must verify the ZIP checksum and both file checksums, refuse pre-existing targets, extract, pass Bash syntax and offline unit tests, and run `--plan`. It must not overwrite any previous scripts or untracked recovery materials.

## Verification sequence

From the project root, after installing:

```bash
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/prepare-local-persistent-pilot.sh --verify
```

If that passes and the original database is stopped, the *independent live audit* is:

```bash
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  PULSE_APPROVE_5U2F2D_READ_ONLY_AUDIT=START_AUDIT_STOP_ZERO_ROWS \
  bash scripts/telemetry-persistent/prepare-local-persistent-pilot.sh --audit
```

On failure, **do not proceed to another step or manually modify any PostgreSQL directories**. Send the error output for a targeted correction. A failed shutdown is considered a critical failure.

## Not yet authorized: first retained telemetry write

Before the very first operational sample is permitted, we need a distinct, security-reviewed persistent-pilot lifecycle with: trusted authenticated organization provisioning; explicit agent enrollment, device identity, and owner-only credential custody; exactly one approved Linux agent; narrow HTTPS loopback ingress with TLS verification and quotas; the restricted SQL execution path; transaction-scoped, tenant-checked history reads; post-write audit assertions that check **expected** (not zero) operational rows without weakening FORCE RLS; reliable shutdown, backup rotation/recovery and rollback; and complete negative testing for foreign-tenant data, revoked credentials, invalid payloads, and double submissions.

**5U-2F2D passing means only “pilot preparation gate verified.” It is not permission to run persistent telemetry writes, to open a public service, or to onboard customers. PUBLIC LAUNCH: NO-GO.**
