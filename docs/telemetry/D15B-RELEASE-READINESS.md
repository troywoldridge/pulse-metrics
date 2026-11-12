# Pulse Metrics — D15B Release Readiness

**Status:** Candidate — security approval pending
**Public deployment:** NO_GO
**Migration:** scripts/telemetry-ingestion/migrations/0001_telemetry_ingestion.sql

## 1. Purpose

D15B establishes PostgreSQL-backed, credential-authenticated
telemetry ingestion for a commercial multi-tenant monitoring service.

The ordinary application role must not insert telemetry directly.

Machine ownership is derived from a verified credential inside
the privileged PostgreSQL ingestion function.

## 2. Verified test coverage

The disposable PostgreSQL rehearsal has demonstrated:

- Original migration replay and historical-source integrity.
- Valid enrollment and authenticated telemetry insertion.
- Separate telemetry ownership for two synthetic organizations.
- Idempotent submission retries and conflict detection.
- Concurrent identical and conflicting submissions.
- Credential revocation and expiration enforcement.
- Required telemetry:write permission enforcement.
- Rejection of unauthorized application database operations.
- Controlled revocation and rotation lock ordering.
- Rejection of direct telemetry INSERT with valid tenant context.
- Detection of a simulated legacy permission regression.
- Release-gate acceptance of secure database permissions.
- Release-gate rejection of restored direct INSERT privileges.
- Preservation of the development database catalog.
- Disposal of the isolated PostgreSQL test cluster.

These results apply only to the tested implementation and conditions.

## 3. Deployment restrictions

The current SQL migration is a reviewed candidate, not an
approved production migration.

It requires PostgreSQL administrator privileges and is not
installed through the ordinary Drizzle migration command.

Do not run this SQL against development, staging, or production
until an explicitly reviewed installation process is available.

Do not modify historical migration source files.

Do not apply the original runtime-grants.sql bootstrap script
after D15B; it can restore an unauthorized telemetry INSERT grant.

## 4. Requirements before approving installation

- Independently verify the intended target database.
- Confirm migration prerequisites and installation ordering.
- Approve the privileged migration executor and role strategy.
- Establish immutable source fingerprint verification.
- Establish an append-only privileged migration receipt.
- Prevent accidental reapplication of the migration.
- Confirm a successful backup and tested recovery procedure.
- Document expected downtime and transaction-lock implications.
- Run required tests on an isolated representative database.
- Make the read-only D15B release permission gate mandatory.
- Block release on any permission-audit failure.
- Verify application compatibility after revoking direct INSERT.
- Obtain explicit migration security and deployment approval.

## 5. Mandatory post-migration permission audit

Audit source:

scripts/telemetry-ingestion/release-permission-gate.sql

The deployment controller must execute this audit using an
authorized read-only audit connection after installation,
upgrade, restore, or privilege modification.

A nonzero result must block release.

Successful execution does not prove that all HTTP, application,
network, or operational security requirements are satisfied.

## 6. Recovery strategy

No automatic reverse migration is approved.

Do not restore the legacy direct telemetry INSERT grant
as an emergency workaround.

If deployment fails:

1. Stop the release process.
2. Keep telemetry ingestion unavailable to customers.
3. Capture sanitized failure evidence.
4. Determine whether the installation transaction committed.
5. Follow an approved restore or forward-repair procedure.
6. Revalidate the restored database and all security grants.
7. Run the mandatory release gate.
8. Resume only after explicit operational approval.

A backup alone is not proof of recoverability.

## 7. Remaining work beyond D15B

- Authenticated HTTPS telemetry endpoint.
- Request authentication and ingress rate limiting.
- Safe handling of machine credentials at the API boundary.
- Real Linux agent-to-server integration testing.
- Tenant-scoped dashboard queries and historical retrieval.
- Monitoring, alerting, incident handling, and operations.
- Commercial deployment security and launch approval.

## 8. Decision

D15B behavioral and permission-gate rehearsals: PASSED.

D15B migration lifecycle and final security approval: PENDING.

Public SaaS launch: NO_GO.
