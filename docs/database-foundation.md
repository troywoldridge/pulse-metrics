# Database foundation

Pulse Metrics uses PostgreSQL with Drizzle ORM. The initial schema establishes
organization ownership, provider-neutral user identities, memberships,
monitored agents, enrollment credentials, telemetry samples, and audit events.

## Install and configure

1. Copy `.env.example` to `.env`.
2. Create a local PostgreSQL database.
3. Configure `MIGRATION_DATABASE_URL` for a dedicated schema-migration role.
4. Configure `DATABASE_URL` for a separate restricted application runtime role.
5. Run `npm install` after pulling the branch so the lockfile matches package.json.
6. Run `npm run db:generate` and review the generated SQL before applying it.
7. Verify that the migration enables and **forces** RLS on every tenant table.
8. Run `npm run db:migrate` only against the intended development database.

Do not use a production database for initial schema experimentation. Do not
use the migration connection in the running API.

## Database roles

Use separate PostgreSQL roles for migrations and application runtime:

- The migration role is tightly controlled and can apply reviewed migrations.
- The application runtime role must be a dedicated non-superuser role with
  neither `BYPASSRLS` nor ownership of tenant tables.
- Do not run the public API as the PostgreSQL superuser or table owner.
- Grant the runtime role only the table and sequence privileges it needs.
- The runtime role must not receive direct privileges on enrollment-token or
  agent-credential tables.
- Keep deployment/migration credentials out of API process environments.

Production runtime and migration URLs must use TLS with certificate and
hostname verification (for example, `sslmode=verify-full` with a trusted CA).
A hostname mismatch or untrusted certificate must fail closed.

## Row-Level Security

PostgreSQL combines permissive policies with OR and restrictive policies with
AND. A future permissive policy can therefore accidentally widen access unless
a tenant boundary is also enforced restrictively.

The schema defines restrictive tenant-boundary policies for customer data.
Agent enrollment and credential tables have restrictive false policies and no
permissive policies; direct application access remains denied.

Drizzle generates `ENABLE ROW LEVEL SECURITY` for tables with policies, but
the generated migration must also contain `FORCE ROW LEVEL SECURITY` for all
eight tables:

- `organizations`
- `users`
- `organization_memberships`
- `monitored_agents`
- `agent_enrollment_tokens`
- `agent_credentials`
- `telemetry_samples`
- `audit_events`

Add the corresponding `ALTER TABLE ... FORCE ROW LEVEL SECURITY;` statements
to the reviewed migration before applying it. FORCE makes table owners subject
to RLS too; PostgreSQL superusers and roles with `BYPASSRLS` still bypass it,
so the application runtime must never have either attribute.

User-initiated tenant queries must use `withOrganizationContext()`. That helper:

1. Starts a database transaction.
2. Clears organization context and sets the verified local user ID.
3. Queries that user's own membership under the membership RLS policy.
4. Rejects the request unless the user belongs to the requested organization.
5. Sets the organization ID with transaction-local `set_config(..., true)`.
6. Runs the requested database work in the same transaction.

Never accept a user ID from an untrusted browser field as proof of identity;
it must come from a verified authentication session. Transaction-local
settings prevent a pooled connection from retaining one request's tenant
context for a later request.

The application must also enforce role-based authorization. RLS establishes
the organization boundary; it does not decide whether a member is an owner,
administrator, member, or viewer. Membership writes, organization provisioning,
agent creation, and agent-state changes deliberately have no ordinary runtime
RLS write policy yet.

The user runtime must not have `BYPASSRLS`. Tenant isolation must be tested
using the same restricted role and connection path used by the application.
Tests using a superuser or table owner do not prove tenant isolation.

Initial organization provisioning is not implemented. It will need a separate,
narrowly scoped flow that creates an organization and its first owner membership
atomically after the user's identity has been verified. Do not bypass the
membership check in `withOrganizationContext()` for provisioning.

Agent ingestion will use a separate verified-agent context after a credential
has been securely resolved. Do not reuse a browser user's context for agent
requests.

## Identity and privacy

The `users` table stores an external identity-provider subject rather than
password hashes. Authentication remains provider-neutral; the future
authentication adapter must verify provider tokens before mapping a subject
to a local user.

Global user profiles are visible only to the user themselves. Ordinary runtime
queries cannot insert or update identity-provider subjects or verified-email
fields. A trusted authentication adapter must own identity synchronization.

## Agent secrets

Enrollment tokens and agent credentials store SHA-256 token hashes, never
plaintext bearer tokens. Plaintext tokens must be displayed only once at
creation and must not be logged.

The secret tables are intentionally inaccessible to ordinary application
queries. Do not weaken the restrictive policies to make an endpoint work.
Credential verification will require a narrowly scoped isolated service or
carefully reviewed database function with minimal privileges. If a dedicated
verification role needs `BYPASSRLS`, it must be NOLOGIN, narrowly owned and
not exposed as a general-purpose application connection. Credential
verification must happen before setting agent tenant context.

## Telemetry and retention

Telemetry samples contain indexed scalar metrics for common queries and a
JSONB metrics document for versioned extension. The API must validate schema
version, payload size, timestamps, metric ranges, and agent ownership before
insert.

Historical retention, partitioning, compression, and customer-configurable
retention limits are deferred until real ingestion volumes and plan
requirements are measured. Define and publish retention periods before
collecting customer telemetry in production.

## Audit events

Audit events are append-only for the ordinary application role. Store only
allowlisted metadata; never include bearer tokens, passwords, database URLs,
private keys, or raw command output.

## Current scope

This foundation does not yet add signup, billing, session management,
first-organization provisioning, agent enrollment endpoints, credential
verification, telemetry ingestion routes, or a production-ready API
authorization layer. Those must be implemented and tested before customer
onboarding or public deployment.
