# Pulse Metrics — Phase 2E3C5A: Migration reconciliation baseline

**Status:** Local read-only audit foundation. **NOT a reproducible production migration.**
**Reviewed GitHub baseline:** `4c412e3ef555c47895250a3ca87dae5d27d6650f` on `feat/identity-organization-onboarding`.

## Why this audit exists

The checked-in `drizzle/0000_damp_tomorrow_man.sql` creates the original eight application tables, types, foreign keys and RLS policies. Later security work used six reviewed `scripts/admin/001_*` through `006_*` SQL scripts for WorkOS identity functions, organization operations, invitation issue/acceptance, verified-email synchronization, and shared rate-limit state. These administrative operations are **not encoded in the Drizzle migration journal**. Therefore `npm run db:check` does **not** prove that a new database can reproduce the actual deployed security model.

A PostgreSQL cluster has two separate deployment concerns: database/schema migrations under a restricted migrator, and carefully controlled administrator operations to create the NOLOGIN, BYPASSRLS `SECURITY DEFINER` function-owner roles and their narrow grants. Do not attempt to run privileged bootstrap scripts as `pulse_metrics_app`, and do not weaken PostgreSQL role privileges to make an automated migration appear to work.

## What Phase 2E3C5A adds

- `scripts/audit-migration-foundation.sh` refuses nonlocal/production/non-runtime targets, confirms one original Drizzle journal entry and six SQL bootstrap sources, prints SHA-256 of **SQL source files only**, and runs a PostgreSQL admin audit.
- `scripts/audit/migration-security-invariants.sql` runs inside `BEGIN READ ONLY`, verifies database version and the actual Drizzle ledger, FORCE RLS and ownership of ten protected tables, runtime role restrictions, narrow executor role attributes, selected SECURITY DEFINER function settings, and direct-table permission boundaries.
- No application routes, database tables, functions, privileges, migration history, network configuration, WorkOS secrets, agents, or telemetry are changed.

**Scope limitations:** This audit tests specific structural security invariants, not a complete schema comparison, a live session/revocation test, backup verification, or a fresh-db deployment. It does not prove every possible permission or RLS policy combination. Review its SQL before running, and continue the existing tenant isolation tests separately.

## Running locally

```bash
cd ~/Projects/pulse-metrics
set +e
bash scripts/audit-migration-foundation.sh
AUDIT_RESULT=$?
echo "Migration baseline audit exit code: $AUDIT_RESULT"
git status --short
```

It uses local `sudo -u postgres psql` exactly as earlier security test scripts. It does not use `DATABASE_URL` for PostgreSQL administrator access; the URL is inspected to **refuse** incorrect targets and is never printed. All generated hashes are hashes of tracked SQL, not credentials or row data. If an invariant fails, stop and inspect the observed structure before applying any DDL.

## Phases after a clean baseline

1. **2E3C5B — Fresh replay in a disposable local database.** Design separate, versioned role-bootstrap and schema/function deployment lanes; verify all six reviewed SQL sources' dependencies and required privileges. Use only explicitly named temporary databases and roles with strict cleanup, not the existing `pulse_metrics` database.
2. **2E3C5C — Reconciliation and adoption strategy.** Establish ordered, reviewable, repeatable migrations and a safe adoption plan for preexisting installations. Never forge a Drizzle migration ledger row or replay non-idempotent SQL against the live development database.
3. **2E3C5D — Security and rollback rehearsal.** Confirm executor role grants, FORCE RLS, tenancy tests, secure schema drift detection, backups, failure recovery and retention. Add CI validation against a fresh isolated PostgreSQL environment.

No public deployment, invitation acceptance activation, production proxy settings or WorkOS key exchange should be triggered by this audit.
