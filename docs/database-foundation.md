# Database foundation

Pulse Metrics uses PostgreSQL with Drizzle ORM. The first schema establishes
organization ownership, provider-neutral user identities, memberships,
monitored agents, enrollment credentials, telemetry samples, and audit events.

## Install and configure

1. Copy `.env.example` to `.env`.
2. Create a local PostgreSQL database and a dedicated local migration account.
3. Set `DATABASE_URL` to the local connection URL.
4. Run `npm install` after pulling the branch so package-lock.json matches
   package.json.
5. Run `npm run db:generate` and review the generated SQL before applying it.
6. Run `npm run db:migrate` only against the intended development database.

Do not use a production database for initial schema experimentation.

## Database roles

Use separate PostgreSQL roles for migrations and application runtime:

- The migration role owns schema objects and can apply reviewed migrations.
- The application runtime role must be a dedicated non-superuser role with
  neither `BYPASSRLS` nor ownership of tenant tables.
- Do not run the public API as the PostgreSQL superuser.
- Grant the runtime role only the table and sequence privileges it needs.
- Keep enrollment-token and agent-credential access denied to ordinary
  application queries until the controlled verification flow is implemented.

Production connection URLs must use `sslmode=verify-full`. Use a trusted
certificate and a hostname covered by that certificate.

## Row-Level Security

Tenant-owned tables have PostgreSQL Row-Level Security policies. User-initiated
tenant queries must use `withOrganizationContext()`. That helper:

1. Starts a database transaction.
2. Clears any organization context and sets the verified local user ID.
3. Queries that user's own membership under the membership table's RLS policy.
4. Rejects the request unless the user is a member of the requested organization.
5. Sets the organization ID using transaction-local `set_config(..., true)`.
6. Runs the requested database work in the same transaction.

The settings are local to the transaction so pooled connections cannot retain
one request's tenant context for a later request. Never accept a user ID from an
untrusted browser field as proof of identity; it must come from a verified
authentication session.

The application runtime can read a user's own identity row but cannot create
or update identity-provider subjects or verified email fields through ordinary
table access. A trusted authentication adapter must own identity synchronization.

The application must still perform role-based authorization. RLS establishes
the organization boundary; it does not decide whether a member is an owner,
administrator, member, or viewer.

The runtime role must not have `BYPASSRLS`. Tenant isolation must be tested
using the same role and connection path used by the application. Tests using a
superuser or table owner do not prove tenant isolation.

Initial organization provisioning is not implemented yet. It will need a
separate, narrowly scoped flow that creates an organization and its first owner
membership atomically after the user's identity has been verified. Do not
bypass the membership check in `withOrganizationContext()` for provisioning.

Agent ingestion will use a separate verified-agent context after a credential
has been securely resolved. Do not reuse a browser user's context for agent
requests.

## Identity and privacy

The `users` table stores an external identity-provider subject rather than
password hashes. Authentication remains provider-neutral; the future
authentication adapter must verify provider tokens before mapping a subject
to a local user.

Global user profiles are visible only to the user themselves. Organization
memberships have a tenant-scoped display name so ordinary team views do not
need to expose a user's global email address to every organization. The
organization lookup flow should first resolve the user's memberships and then
read each organization through a membership-verified tenant transaction.

## Agent secrets

Enrollment tokens and agent credentials store SHA-256 token hashes, never
plaintext bearer tokens. Plaintext tokens must be displayed only once at
creation and must not be logged.

The enrollment-token and agent-credential tables deliberately deny direct
application access in this foundation. Do not weaken those policies to make
an endpoint work. The enrollment and credential-verification flow should use
a narrowly scoped, reviewed database function or isolated service with
minimal privileges. Credential verification must happen before setting the
organization context; after verification, telemetry writes must run in the
resolved organization context.

## Telemetry and retention

Telemetry samples contain a few indexed scalar metrics for common queries and
a JSONB metrics document for versioned extension. The API must validate
schema version, payload size, timestamps, metric ranges, and agent ownership
before insert.

Historical retention, partitioning, compression, and customer-configurable
retention limits are intentionally deferred until real ingestion volumes and
plan requirements are measured. Define and publish retention periods before
collecting customer telemetry in production.

## Audit events

Audit events are append-only for the ordinary application role. Store only
allowlisted metadata; never include bearer tokens, passwords, database URLs,
private keys, or raw command output.

## Current scope

This foundation does not yet add signup, billing, session management, first
organization provisioning, agent enrollment endpoints, credential verification,
telemetry ingestion routes, or a production-ready API authorization layer.
Those must be implemented and tested before customer onboarding or public
deployment.
