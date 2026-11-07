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
- The migration role is a dedicated non-superuser login that owns the schema
  objects it creates. It must not be used by the API.
- The runtime role is a separate non-owner login with `NOSUPERUSER`,
  `NOBYPASSRLS`, and no membership in privileged roles.
- A future agent-authentication component will use a separately reviewed,
  narrowly scoped database function or isolated service. Do not grant the
  general API role direct access to token hashes or credential rows.

Production runtime and migration URLs must use TLS with certificate and
hostname verification (for example, `sslmode=verify-full` with a trusted CA).
A hostname mismatch or untrusted certificate must fail closed.

## Explicit role and grant plan

The following is the initial local-development role model. Run role creation
while connected to the dedicated `pulse_metrics` database as a PostgreSQL
administrator. Choose passwords interactively with psql's `\password`
command; never put passwords in this document, shell history, source control,
or connection URLs that may be logged.

Create the two login roles as a PostgreSQL administrator. These roles are
specific to this database; do not reuse them for other applications:

```sql
CREATE ROLE pulse_metrics_migrator
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE pulse_metrics_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE pulse_metrics
  TO pulse_metrics_migrator, pulse_metrics_app;

-- Drizzle Kit's PostgreSQL migrator issues CREATE SCHEMA IF NOT EXISTS for
-- its configured migration-ledger schema. The config pins that schema to
-- public, so grant schema-creation privilege only to the migration role.
-- This does NOT grant CREATEDB or CREATEROLE.
GRANT CREATE ON DATABASE pulse_metrics TO pulse_metrics_migrator;

-- Keep the public schema usable, but prevent arbitrary database users
-- from creating objects there.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Migrations create and own tables, types, indexes, policies and the ledger.
GRANT USAGE, CREATE ON SCHEMA public TO pulse_metrics_migrator;

-- The running API can resolve objects but cannot create or alter them.
GRANT USAGE ON SCHEMA public TO pulse_metrics_app;

-- Make the runtime role's object resolution deterministic. User-defined
-- migration SQL uses unqualified table names and must land in public.
ALTER ROLE pulse_metrics_migrator IN DATABASE pulse_metrics
  SET search_path = public;
ALTER ROLE pulse_metrics_app IN DATABASE pulse_metrics
  SET search_path = public;

-- Make future objects created by the migration role private unless explicitly
-- granted after review. The migration ledger is also in public, so these
-- defaults protect it from PUBLIC and the ordinary runtime role.
ALTER DEFAULT PRIVILEGES FOR ROLE pulse_metrics_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, pulse_metrics_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pulse_metrics_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, pulse_metrics_app;

-- Function EXECUTE is granted to PUBLIC by PostgreSQL by default.
-- This must be revoked globally; a schema-scoped revoke cannot cancel
-- the global default privilege.
ALTER DEFAULT PRIVILEGES FOR ROLE pulse_metrics_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

Set each password interactively in the same psql session. Do not put passwords
in SQL files, shell history, source control, or connection URLs that may be
logged:

```text
\\password pulse_metrics_migrator
\\password pulse_metrics_app
```

The migration URL must authenticate as `pulse_metrics_migrator`; the API URL
must authenticate as `pulse_metrics_app`. Drizzle's migration ledger is
explicitly configured as `public.__drizzle_migrations`, not the default
`drizzle.__drizzle_migrations`; the default table/sequence privileges above
keep that ledger private from the API role. URL-encode reserved characters in
passwords when building PostgreSQL connection URLs. Do not grant either login
membership in privileged roles. Do not make the API role a member of the
migration role.

After the reviewed migration has been applied, grant the ordinary API role
only its initial read and append operations:

```sql
GRANT SELECT ON
  public.organizations,
  public.users,
  public.organization_memberships,
  public.monitored_agents,
  public.telemetry_samples,
  public.audit_events
TO pulse_metrics_app;

GRANT INSERT ON
  public.telemetry_samples,
  public.audit_events
TO pulse_metrics_app;

GRANT USAGE, SELECT ON SEQUENCE
  public.telemetry_samples_id_seq
TO pulse_metrics_app;

-- The secret tables remain inaccessible to the ordinary API role.
REVOKE ALL ON
  public.agent_credentials,
  public.agent_enrollment_tokens
FROM PUBLIC, pulse_metrics_app;

-- Telemetry and audit rows are append-only for this role.
REVOKE UPDATE, DELETE, TRUNCATE ON
  public.audit_events,
  public.telemetry_samples
FROM PUBLIC, pulse_metrics_app;
```

These grants are deliberately incomplete for a functioning product: signup,
organization provisioning, membership administration, agent creation,
heartbeat updates, credential verification, and enrollment-token redemption
need dedicated, reviewed service operations. Do not solve missing features by
granting broad table access. A later agent-authentication component must be
introduced alongside a narrowly scoped credential-verification operation and
security tests; it is not granted direct secret-table access in this initial
foundation.

Before using these statements, verify that the target is the dedicated
`pulse_metrics` development database and that the schema is `public`. Do not
run them against any existing production database or a database used by
unrelated services. Hosted PostgreSQL providers may impose different database
and schema ownership rules; adapt the administrator setup to the provider's
documented model while preserving the separation of runtime and migration
roles.

## Row-Level Security

PostgreSQL combines permissive policies with OR and restrictive policies with
AND. A future permissive policy can therefore accidentally widen access unless
a tenant boundary is also enforced restrictively.

The schema defines restrictive tenant-boundary policies for customer data.
Agent enrollment and credential tables have RLS enabled but intentionally have
no policies. PostgreSQL therefore applies default-deny row access until a
specific, reviewed policy is introduced. This is preferable to a permanent
restrictive false policy, which would continue denying access even after a
future permissive policy was added.

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

Append these statements to the reviewed initial migration before applying it:

```sql
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "monitored_agents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_enrollment_tokens" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;
ALTER TABLE "telemetry_samples" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
```

FORCE makes table owners subject to RLS too; PostgreSQL superusers and roles
with `BYPASSRLS` still bypass it, so the application runtime must never have
either attribute.

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

Important trust boundary: PostgreSQL custom settings such as
`app.current_organization_id` are not secrets or unforgeable identity claims.
The shared API database role can set them. These policies protect against
missing tenant filters and ordinary application mistakes when all user
queries go through the verified context helper; they do not contain arbitrary
SQL execution or a full compromise of the API process. Prevent SQL injection,
keep database access behind parameterized service operations, and test the
authorization layer independently. Do not describe this GUC-based design as
protection against an attacker who can execute arbitrary SQL as the runtime
role.

The application must also enforce role-based authorization. RLS establishes
the organization boundary; it does not decide whether a member is an owner,
administrator, member, or viewer. Membership writes, organization provisioning,
agent creation, and agent-state changes deliberately have no ordinary runtime
RLS write policy yet.

The user runtime must not have `BYPASSRLS` and must not own tenant
tables. PostgreSQL superusers and `BYPASSRLS` roles bypass RLS even when
`FORCE ROW LEVEL SECURITY` is enabled. Tenant isolation must be tested using
the same restricted role and connection path used by the application.
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

The secret tables have RLS enabled and no policies, so ordinary row access
is default-denied. Do not grant the general API role direct access to these
tables. Credential verification and enrollment redemption will require a
narrowly scoped isolated service or carefully reviewed database function with
minimal privileges. Prefer a function with a fixed, audited query surface over
granting a login role `BYPASSRLS`. Credential verification must happen before
setting agent tenant context.

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

Audit events are append-only for the ordinary application role. The
schema enforces an actor-type/actor-ID consistency check and limits serialized
metadata to 256 KiB. Database grants must withhold `UPDATE`, `DELETE`,
and `TRUNCATE` from the runtime role. Store only allowlisted metadata;
never include bearer tokens, passwords, database URLs, private keys, or raw
command output.

## Current scope

This foundation does not yet add signup, billing, session management,
first-organization provisioning, agent enrollment endpoints, credential
verification, telemetry ingestion routes, or a production-ready API
authorization layer. Those must be implemented and tested before customer
onboarding or public deployment.
