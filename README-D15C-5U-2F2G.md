# Pulse Metrics — D15C-5U-2F2G Guarded Persistent Pilot Candidate

**Status:** Candidate — offline tests passed. Live operation must run on the owner's Linux machine.
**Reviewed:** 2026-11-16
**Launch:** `NO_GO` — no persistent telemetry writes or public service authorized.

## Scope

This stage establishes a **separate, fail-closed pilot operator** without changing the original
`local-development-postgres.sh` (which intentionally requires zero operational rows).

It provides:

1. `scripts/telemetry-persistent/pilot-inventory-policy.mjs`: pure bounded *one-organization, one-agent* inventory contract. Explicit identities and sample limits must come from an **independently approved operator policy**, never inferred from rows already in PostgreSQL. Rejects excess tenants, agents, credentials, users, rows, orphan/foreign ledger records, RLS or grant failures, leaked context, unexpected agent status, and unknown fields.
2. `scripts/telemetry-persistent/pilot-inventory-policy.test.mjs`: 15 offline fail-closed tests. These use **fixtures**, not an authenticated PostgreSQL connection.
3. `scripts/telemetry-persistent/guarded-persistent-pilot.sh`: complete separate operator with `--plan`, `--verify`, and explicitly approved `--exercise-empty` only. It checks pinned existing operator/backup/source files, re-runs policy tests and existing read-only preflight, and delegates empty database start/audit/stop to the already reviewed zero-row procedure.

## Explicitly **not** included

- No nonzero-data live database adapter or authorized pilot manifest. Bounded policy validation is a **candidate**, not live enforcement.
- No persistent enrollment, credential creation, telemetry insertion, network listener, migration, running agent, public API, or promotion.
- No new or changed SQL privileges and no changes to retained backup or protected cluster.
- No assertion that this is a complete operational pilot. That requires a reviewed SQL inventory loader, independently attested allowlist, supported nonzero startup/restart controls, fresh restore point, and authentic write-path rehearsal.

## Exact reviewed scope

- Git branch: `feat/identity-organization-onboarding`.
- Project: `~/Projects/pulse-metrics`.
- Protected stopped cluster: `/var/lib/postgresql/pulse-metrics-dev-5u2/data` (PostgreSQL 16, private Unix socket, port `55433`).
- Retained same-host cold backup remains unchanged and verified.
- The operator refuses `--write`, `--audit-nonzero`, `--start`, production, inherited database/PG connection redirection, unsafe TLS/Node env, and public ingress/service activation.
- All commands have bounded preconditions and do not alter unrelated Git files.

## Commands (run from repository root)

```bash
bash -n scripts/telemetry-persistent/guarded-persistent-pilot.sh
node --test scripts/telemetry-persistent/pilot-inventory-policy.test.mjs
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/guarded-persistent-pilot.sh --plan

# Stops at source hashes, baseline, backup, and offline checks. No server started:
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/guarded-persistent-pilot.sh --verify

# Optional guarded START -> READ ONLY AUDIT -> STOP exercise of the STILL-EMPTY cluster:
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE=START_AUDIT_STOP_NO_WRITES \
  bash scripts/telemetry-persistent/guarded-persistent-pilot.sh --exercise-empty
```

**Do not** run the live exercise if `--verify` reports an unexpected state. If an audit/cleanup fails, do not manually delete or restart PostgreSQL; inspect logs and verify the dedicated cluster's state first.

## Completion criteria for 2F2G

- New files installed with verified SHA-256 checksums and no other files overwritten.
- All 15 offline tests pass.
- Existing pinned-source, stopped-database and retained-backup verification passes.
- Optional independently approved empty-data exercise performs a verified start/audit/stop and rechecks the backup.
- No persistent data is inserted, no ready marker is created, and launch remains `NO_GO`.

**The next milestone** must prove the one-agent contract against real restricted PostgreSQL transactions and exact independently approved pilot identity before enabling a nonzero-data persistent startup and first real measurement.
