# Pulse Metrics — Phase 2C: organization creation database boundary

**Status:** Local-development implementation; not production ready.

## Purpose and sequence

`public.create_workos_organization(p_subject, p_name, p_slug)` creates an organization, its sole initial `owner` membership for an already-provisioned WorkOS user, and an immutable audit event in one database function call/transaction. The browser **never supplies a user ID or role**. It only eventually supplies a proposed organization name and slug; the API must provide `p_subject` from a freshly verified WorkOS access token.

This **does not yet expose a browser API** or UI; both will be added separately after database security and integration checks pass. Existing monitoring APIs remain disabled and WebSocket upgrades remain blocked.

## Security boundary

- Separate `pulse_metrics_onboarding_executor` role: `NOLOGIN`, `NOINHERIT`, `BYPASSRLS`, zero role memberships. PostgreSQL `BYPASSRLS` is globally potent; only fixed, reviewed SECURITY DEFINER functions may use it. The executor must never gain LOGIN or be granted to another role.
- Grant restricted column-level SELECT on `users` and INSERT on `organizations`, `organization_memberships` and `audit_events`. No broad UPDATE/DELETE/TRUNCATE. No ordinary application role privileges are widened.
- `public.create_workos_organization` uses fixed `search_path=pg_catalog, pg_temp`, fully qualified table references, no dynamic SQL; `PUBLIC` has no EXECUTE. The only role permitted to execute it is `pulse_metrics_app` (other than owners/superusers).
- Creates membership with `role='owner'` internally. No caller-specified role, arbitrary org ID, email-based ownership, or membership into an existing organization.
- Database validates known WorkOS subject, nonempty printable organization name, strictly formatted slug; unique constraint rejects slug collisions.
- One database statement atomically inserts org, owner membership and audit event; failure prevents partial creation.
- Database itself cannot verify WorkOS JWT signatures. The API remains responsible for authentication, authorization, request validation, rate limiting, anti-CSRF/abuse protections where applicable, log hygiene and user-to-subject binding. A compromised API/database runtime role can call the privileged function with arbitrary WorkOS-shaped subject values; treat this as a significant privilege boundary. Do not expose this helper as an arbitrary SQL endpoint.
- Organization creation is not idempotent across different slugs. Client retries require careful handling to avoid accidental duplicates. Invitations/organization membership management are **not** implemented.

## Installation and verification

1. Inspect `scripts/admin/002_organization_onboarding.sql` carefully.
2. Install locally only:

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics \
  -f scripts/admin/002_organization_onboarding.sql
```

3. Run:

```bash
bash scripts/test-organization-onboarding.sh
bash scripts/test-identity-provisioning.sh
npm run test:integration
npm test
npm run lint
npm run db:check
```

The tests create temporary workos-shaped fixtures through the existing privileged function under the restricted API database role, verify owner assignment, audit event creation, cross-org isolation, negative cases and direct table privileges, then clean fixtures via PostgreSQL administrator.

The SQL is deliberately not a Drizzle schema migration: creation of a `BYPASSRLS` role needs database administrator authority. Maintain a versioned production deployment/bootstrap process later; never place admin credentials in the application runtime.

## Follow-up requirements

- Authenticated `POST /api/organizations` endpoint with body size, name and slug validation; never accept user ID/role.
- Read-only `GET /api/organizations` scoped to the authenticated internal UUID, using transaction-local context and RLS.
- Request-rate and organization-creation abuse limits, slug collision handling, and structured audit review.
- UI for create/select organization; invitation-based join later.
- Role-based authorization tests, RLS cross-tenant integration and eventual WebSocket scoping.

**Keep the prototype dashboard locked and WebSocket upgrades disabled.**
