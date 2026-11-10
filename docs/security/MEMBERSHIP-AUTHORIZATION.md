# Pulse Metrics — Phase 2E1 membership authorization foundation

Status: local development; not public-launch-ready.

## Purpose

A verified WorkOS session and a database user UUID do not automatically confer
access to an organization. Each request must verify an existing membership and
its authorized role, in the same transaction used to read tenant data.

This slice adds one strictly read-only API:

`GET /api/organizations/:organizationId/members`

- WorkOS bearer verification happens at the existing global `/api` middleware.
- The browser never supplies the trusted user identity.
- The internal user UUID is resolved from the verified WorkOS subject.
- `withOrganizationContext` verifies membership before setting tenant context.
- Only owner/admin can see the membership roster; member/viewer are denied.
- Roster data includes user UUID, tenant-local display name, role and joined date.
  It intentionally does not read global user profiles or email addresses.
- A missing membership and an inadequate role both return HTTP 403.
- SQL and server internals are not returned in errors. All results are `no-store`.
- In this first slice, organizations with over 100 members fail closed rather
  than returning incomplete results; design cursor pagination before launch.
- No membership role changes, invitations, removals or monitoring APIs exist.

## Permission matrix for this slice

| Role | List organization members |
|---|---|
| Owner | Yes |
| Admin | Yes |
| Member | No |
| Viewer | No |
| No membership | No |

Other actions will be added only with separately reviewed authorization rules.

## Security considerations

The database RLS policies already protect tenant-owned rows. However, RLS alone
only checks membership, not whether a specific organizational role may perform a
business action. The service layer checks that explicitly. All membership queries
occur inside the `withOrganizationContext` transaction. Never expose a generic
membership list from the global database connection.

The existing PostgreSQL runtime role remains SELECT-only on `organizations`,
`organization_memberships`, and `users`. No changes to RLS, grants, privileged
SQL functions, schema or migration history are made by this package.

The organization creation and identity provisioning routines remain separate,
privileged trust boundaries, and are not modified here.

## Verification

- `npm test` includes the new authenticated endpoint tests and fail-closed role
  matrix tests (10 additional tests).
- `npm run lint` and `npm run build` must pass in the actual repository.
- Re-run the local organization, identity and tenant isolation tests.
- The new API should return `401` without a bearer, `400` for invalid IDs,
  `403` for denied membership/role, `200` for an authorized owner/admin.
- Before implementing write operations, add live PostgreSQL integration tests
  for the exact endpoint with independent organizations and each role.

Do not turn on monitoring endpoints, WebSockets, or public deployment based on
this slice alone. SSH/prototype paths remain disabled by existing server guards.
