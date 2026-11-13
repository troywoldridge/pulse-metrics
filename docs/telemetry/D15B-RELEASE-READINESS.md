# Pulse Metrics — D15B Release Readiness

**Status:** Controlled disposable rehearsal passed; security approval pending
**Public deployment:** NO_GO
**Migration:** scripts/telemetry-ingestion/migrations/0001_telemetry_ingestion.sql
**Last reviewed:** 2026-11-12

## 1. Purpose

D15B establishes PostgreSQL-backed, credential-authenticated
telemetry ingestion for a commercial multi-tenant monitoring service.

The ordinary application role must not insert telemetry directly.
Machine and organization ownership must be derived from a verified
credential inside the protected PostgreSQL ingestion function.

## 2. Reviewed migration identity

Version: 0001

SHA-256:
3a49fc829b985fefe68616dcc525da83138b18e3d199d18d02817d5751f6b513

Manifest:
scripts/telemetry-ingestion/migrations/manifest.json

Verifier:
scripts/telemetry-ingestion/verify-candidate.mjs

Artifact emitter:
scripts/telemetry-ingestion/emit-reviewed-sql.mjs

The manifest and SQL are checked against an independently pinned
fingerprint. The emitter validates the bytes it outputs.

Source verification does not constitute deployment approval.

## 3. Verified database behavior

The disposable PostgreSQL rehearsal has passed:

- Historical migration replay and source integrity verification.
- Correct database ownership, restricted roles, and RLS checks.
- Authenticated enrollment and telemetry persistence.
- Isolation between two synthetic customer organizations.
- Idempotent submissions and conflicting retry rejection.
- Concurrent submission and revocation tests.
- Expired, revoked, and insufficient-scope credential rejection.
- Unauthorized runtime database operation rejection.
- Direct telemetry INSERT bypass rejection.
- Legacy unsafe permission regression detection.
- Protected installation receipt verification.
- Missing and altered receipt rejection.
- Atomic rollback after an intentionally failed migration.
- Duplicate installation refusal.
- Preservation of security controls after rejected reapplication.

These tests demonstrate behavior under the tested conditions only.

## 4. Controlled installation rehearsal

The test-only installation controller uses a disposable PostgreSQL
cluster with the following controls:

- Explicitly verified PostgreSQL data directory.
- Unix socket connection with TCP disabled.
- Restricted PostgreSQL administrative connection wrapper.
- Fixed expected database and database administrator identity.
- Independent migration source fingerprint verification.
- Verified SQL artifact capture before installation.
- Atomic migration transaction.
- Mandatory post-installation release permission audit.
- Release-blocking failure handling.

The controller does not accept arbitrary deployment targets.

It is NOT approved for development, staging, or production use.

## 5. Failure and recovery verification

### Failure before COMMIT

An intentionally broken migration was executed against an isolated
database. PostgreSQL rolled back its uncommitted changes.

The test verified that no D15B schema, executor role, or
installation receipt survived.

### Duplicate installation

A second installation attempt was rejected.

The original installation remained committed and its security
permission audit passed.

### Failure after COMMIT

A deliberate unsafe permission was introduced after installation.

The mandatory release gate rejected the database.

The test verified:

- A nonzero audit result.
- An explicit committed-but-release-blocked warning.
- No false audit-success result.
- Preservation of the committed migration receipt.
- Successful audit after synthetic permission remediation.

A post-commit audit failure does not automatically roll back
committed PostgreSQL changes.

## 6. Mandatory release permission gate

Source:
scripts/telemetry-ingestion/release-permission-gate.sql

The audit must be executed after installation, upgrade, restore,
or privileged permission modification.

Any audit failure must block deployment or continued release
activation until reviewed and remediated.

The historical runtime-grants.sql script must not be reapplied
after D15B because it can restore unsafe direct INSERT privileges.

## 7. Remaining release requirements

Before any deployment approval:

- Review the complete privileged installation lifecycle.
- Require an independently authorized deployment artifact.
- Prove target identity and execution-context validation.
- Review inherited roles and column-level grant exposure.
- Validate cleanup after interrupted or failed installations.
- Establish backup and tested restoration procedures.
- Assess migration locking, downtime, and operational effects.
- Test representative application compatibility.
- Define audit logging and operator approval procedures.
- Obtain explicit security and deployment approval.

A successful disposable rehearsal is not production certification.

## 8. Recovery restrictions

No automatic reverse migration has been approved.

Do not restore legacy telemetry INSERT grants as a workaround.

For an installation or post-installation failure:

1. Stop release activation.
2. Record sanitized failure evidence.
3. Determine whether the transaction committed.
4. Inspect database permissions and migration receipts.
5. Follow an approved restore or forward-repair procedure.
6. Rerun the mandatory release permission gate.
7. Resume only after explicit operational approval.

A backup alone is not proof that recovery works.

## 9. Remaining product development

- Authenticated HTTPS telemetry ingestion endpoint.
- Machine authentication and ingress rate limiting.
- Safe machine-credential handling.
- Real Linux agent-to-server integration.
- Tenant-scoped monitoring and historical retrieval.
- Production observability, incident response, and operations.
- Commercial security and launch approval.

## 10. Decision

D15B source verification: PASSED.

D15B database and privilege rehearsal: PASSED.

D15B atomic rollback and receipt tests: PASSED.

D15B controlled disposable installation rehearsal: PASSED.

D15B production deployment approval: PENDING.

Public SaaS launch: NO_GO.
