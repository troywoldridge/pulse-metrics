# Pulse Metrics — Phase 2A identity provisioning

Status: local development proposal; not a production deployment procedure.

## Purpose

WorkOS verifies the browser access token. A trusted API endpoint then needs to map verified WorkOS `sub` values to a stable UUID in `public.users`. A signed-in user is **not** thereby granted any organization membership or access to telemetry.

The current `pulse_metrics_app` database role has only SELECT on users, organizations and memberships, and those tables have forced RLS. This package leaves those permissions and policies unchanged.

## Security design

`public.resolve_workos_user(text)` is a fixed `SECURITY DEFINER` function that accepts a WorkOS-shaped subject (not an arbitrary provider), inserts a user row if it doesn't already exist, and returns only its UUID. It does not set any organization context, role or membership. It does not accept an email address as identity proof.

The function is owned by `pulse_metrics_identity_executor`: a NOLOGIN, NOINHERIT, BYPASSRLS role with no memberships, schema USAGE and narrowly restricted SELECT/INSERT **column grants on public.users only**. The role has **no permissions** on organizations, memberships, monitoring, telemetry, enrollment tokens or credentials. PostgreSQL BYPASSRLS is globally potent: never grant this role to other roles, give it LOGIN, broaden table grants, or permit user-controlled SQL inside its functions. Audit those boundaries after upgrades. The ordinary API role is never given BYPASSRLS.

`SECURITY DEFINER` SQL uses `SET search_path = pg_catalog, pg_temp`, fully qualified application object names, validated subjects and no dynamic SQL. PUBLIC is denied EXECUTE. The function is inherently a privileged trust boundary: if the runtime API is compromised, an attacker might invoke it for arbitrary subject values. Backend code must only call it with `subject` from a freshly verified WorkOS JWT, and never with browser-provided subject IDs. More controls (rate limiting/audit) are required before public launch.

The admin SQL is separately version-controlled because Drizzle schema migrations cannot create a BYPASSRLS PostgreSQL role when run under the existing restricted migrator. This package **does not add or modify Drizzle migration ledger entries**. Production provisioning requires a reviewed privileged bootstrap and repeatable migration process.

## Local installation

1. Inspect the SQL file before application.
2. Ensure your development shell is in `feat/identity-organization-onboarding`, with a clean Git worktree when you start.
3. Apply locally (as PostgreSQL superuser):

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics -f scripts/admin/001_workos_identity_provisioning.sql
```

4. Run the integration test; it uses the restricted application DB role for all subject resolution, and a privileged `sudo -u postgres` operation solely for fixture cleanup and security audit:

```bash
bash scripts/test-identity-provisioning.sh
npm test
npm run lint
npm run db:check
npm run test:integration
```

5. Review `git status --short` and the test output. Do not commit before reviewing.

This step intentionally **does not connect the function to Express yet**. The existing `/api/auth/me` route remains authentication-only and returns no internal UUID. The dashboard stays locked, and all WebSocket upgrades remain rejected. Next, add a narrow, authenticated API identity adapter and dedicated tests, then implement separately authorized organization creation and membership management.

## Recovery

No existing user rows or tenant permissions are modified by this bootstrap. Remove the function only through a reviewed, explicit admin SQL change; removing the role also requires confirming all dependent objects and grants. Do not run `DROP ... CASCADE` or reset the database.
