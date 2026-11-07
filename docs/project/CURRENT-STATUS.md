# Pulse Metrics — Current Project Status

**Last updated:** 2026-11-07
**Active branch:** feat/commercial-database-foundation

This document is the project handover record. Update it whenever a meaningful milestone is completed or the next development task changes.

## 1. Overall position

Pulse Metrics is transitioning from a monitoring prototype toward a commercial,
multi-tenant infrastructure monitoring service.

The commercial database foundation has been implemented, and the repeatable
PostgreSQL tenant-isolation integration test passes.

The architecture for human authentication, application authorization,
real-time WebSocket delivery and machine-agent authentication has now been
documented in ARCHITECTURE-DECISIONS.md.

WorkOS AuthKit is the selected provider for human authentication. This is an
architectural selection only: WorkOS has not yet been integrated, configured
or tested in the application.

WebSockets will be retained for real-time monitoring and event delivery.
Authenticated WebSocket connections, organization subscriptions and
tenant-isolated event delivery have not yet been implemented.

Monitoring-agent authentication will remain separate from human
authentication. Secure agent enrollment, credential issuance and authenticated
telemetry ingestion have not yet been implemented.

The project is not production-ready and must not be exposed as a public
customer service in its current state.

## 2. Verified progress

### Repository and development foundation

- [x] Canonical repository established:
  https://github.com/troywoldridge/pulse-metrics.git
- [x] Commercial database foundation feature branch created.
- [x] Database architecture documentation exists.
- [x] Runtime and migration database connection settings are separated.
- [x] `.env` is ignored by Git.
- [x] Gemini integration is not required for the core monitoring product.
- [x] Project roadmap, current status, security checklist and architecture
      decision documents are maintained.

### Database infrastructure

- [x] Local PostgreSQL database `pulse_metrics` created.
- [x] Dedicated `pulse_metrics_app` runtime role created.
- [x] Dedicated `pulse_metrics_migrator` role created.
- [x] Both roles verified as non-superuser and without RLS bypass.
- [x] Runtime role cannot create schemas or database objects.
- [x] Migration connection tested.
- [x] Runtime connection tested.
- [x] Initial Drizzle migration applied successfully.
- [x] Eight application tables created.
- [x] Row-level security enabled and forced on all eight application tables.
- [x] Fourteen RLS policies created.
- [x] Application grants restricted to approved operations.
- [x] Application role denied access to enrollment tokens and agent credentials.
- [x] Application role denied telemetry and audit update/delete/truncate.
- [x] Actual runtime permission tests passed.
- [x] Drizzle schema check passed on 2026-11-07.

### Tenant isolation

- [x] Tenant-context helper validates UUID inputs.
- [x] Organization context is cleared before membership verification.
- [x] User identity is set transaction-locally.
- [x] Membership is checked before organization context is installed.
- [x] Organization context is set transaction-locally.
- [x] User A can read Organization A agent and telemetry data.
- [x] User B can read Organization B agent and telemetry data.
- [x] Cross-organization access is denied in the tested paths.
- [x] Unscoped agent and telemetry queries return no tenant rows.
- [x] Malformed organization UUIDs are rejected.
- [x] Malformed user UUIDs are rejected.
- [x] Nonexistent user access is denied.
- [x] Nonexistent organization access is denied.
- [x] Deleted/revoked membership is denied.
- [x] Transaction-local tenant context is cleared after completion.
- [x] Single-connection reuse does not retain the previous tenant context.
- [x] Repeatable integration fixture setup implemented.
- [x] Integration fixture cleanup implemented through an exit trap.
- [x] Integration command documented as `npm run test:integration`.
- [x] Integration command passed twice.
- [x] Separate cleanup query confirmed zero remaining test fixtures.

The repeatable integration test covers the specific tenant-context and
database security scenarios listed above. It is not proof that every possible
tenant-isolation attack path has been covered.

### Automated verification

Verified on 2026-11-07:

| Check | Result |
|---|---|
| `npm run lint` | Passed |
| `npm test` | 13 passed, 0 failed |
| `npm run db:check` | Passed |
| `npm run test:integration` — first run | 2 phases passed |
| `npm run test:integration` — second run | 2 phases passed |
| Test fixture cleanup | All four fixture counts zero |

The production build was not part of this verification run and is not recorded
as passed here.

## 3. Architecture decisions recorded

The following decisions have been added to
`docs/project/ARCHITECTURE-DECISIONS.md`.

### ADR-011 — WorkOS AuthKit for human authentication

**Status: Accepted as the selected provider; integration pending.**

WorkOS AuthKit is the selected human authentication provider.

Before implementation, its current integration requirements must be reviewed
against the existing Express server, React/Vite frontend, session model and
database identity structure.

No WorkOS authentication package or integration has been installed or
implemented as part of this decision.

### ADR-012 — Pulse Metrics owns application authorization

**Status: Accepted.**

WorkOS will authenticate human users. Pulse Metrics will retain responsibility
for internal user mapping, organization membership, roles, permissions and
authorization to customer resources.

Provider identity claims or browser-supplied organization IDs must not replace
server-side authorization checks.

The existing PostgreSQL tenant context and RLS protections remain part of the
data-access security boundary.

### ADR-013 — Authenticated organization-scoped WebSockets

**Status: Accepted as the intended architecture; implementation pending.**

WebSockets will be retained for real-time monitoring and event delivery,
including live metric updates, agent status changes, alerts and authorized
diagnostic progress.

Browser WebSocket connections must be authenticated. Organization
subscriptions and protected actions must be authorized by the server.
Events must never be broadcast across customer organization boundaries.

WebSockets are for real-time delivery and notification. PostgreSQL remains
the persistent source for stored application and telemetry data.

The existing prototype WebSocket implementation is not considered secure
or production-ready.

### ADR-014 — Separate human identity from machine/agent authentication

**Status: Accepted as the intended architecture; implementation pending.**

Human users and monitoring agents will use separate authentication systems.

WorkOS AuthKit is intended for human identity. Monitoring agents will use
separate machine credentials issued through a secure enrollment process.

Browser sessions must never be reused as agent credentials.

### Important implementation distinction

Recording an architecture decision does not mean the feature is implemented.

At this point:

- WorkOS AuthKit has been selected but is not integrated.
- Trusted server-side human identity verification is not implemented.
- Application-level organization role enforcement is not complete.
- Browser WebSocket authentication is not implemented.
- Organization-scoped WebSocket subscriptions and event authorization are
  not implemented.
- Separate agent credential issuance and verification are not implemented.
- Authenticated telemetry ingestion is not implemented.

## 4. Current worktree and Git state

The architecture decision document has been updated with ADR-011 through
ADR-014. The roadmap and current-status documents are being aligned with
those decisions.

Check the exact worktree state before staging or committing:

```bash
git status --short
git diff --check
```

Preserve all existing work. Do not discard, reset or overwrite unrelated
changes.

Do not assume that documentation changes have been committed. Verify the
Git status and review the diff before creating a commit.

## 5. Completed milestone

**Milestone:** Repeatable PostgreSQL tenant-isolation integration tests.

The milestone's defined requirements have been met:

- [x] Tests create their own temporary fixtures.
- [x] Application-path operations use the restricted runtime database role.
- [x] Cross-tenant access is denied in the tested scenarios.
- [x] Missing and revoked membership is denied.
- [x] Invalid UUID inputs are rejected.
- [x] Transaction-local tenant context is cleared.
- [x] A single pooled connection can be reused without tenant-context leakage.
- [x] Cleanup is attempted after test execution, including failure paths.
- [x] The documented command runs successfully.
- [x] The integration command has passed twice.
- [x] Cleanup verification reports zero remaining fixtures.
- [x] Unit tests, TypeScript checks and Drizzle schema checks pass.

This milestone completes the current database tenant-isolation test objective.
It does not complete the application's overall security or production
readiness requirements.

## 6. Known limitations and future work

The database foundation and accepted architecture decisions are not the
complete application security model.

Still required:

- WorkOS AuthKit integration and configuration.
- Secure authentication verification and session handling.
- Trusted server-side user identity.
- Internal user mapping to verified provider identities.
- Organization provisioning and membership administration.
- Organization role and permission enforcement.
- Authenticated and authorized browser WebSocket connections.
- Organization-scoped WebSocket subscriptions and event delivery.
- Tests preventing cross-tenant real-time event delivery.
- Agent enrollment and credential verification.
- Agent credential rotation and revocation.
- Authenticated telemetry ingestion.
- API authorization and rate limiting.
- Audit-event generation and review.
- Customer dashboard authorization.
- Removal of prototype arbitrary SSH/WebSocket command execution.
- Removal of fabricated telemetry and hardcoded prototype host assumptions.
- Subscription and billing enforcement.
- Operational monitoring, backup and recovery.
- Data retention and deletion policies.
- Security, performance and production acceptance testing.

The existing prototype's arbitrary SSH/WebSocket command execution must not
be exposed as an unauthenticated customer capability. WebSockets are being
retained for authorized real-time delivery, not arbitrary remote command
execution.

## 7. Next development milestone

**Next milestone: WorkOS integration review, authentication, trusted identity
and organization access.**

Recommended sequence:

1. Review WorkOS AuthKit's current Node.js integration and configuration
   requirements.
2. Confirm how WorkOS authentication will fit the existing Express server
   and React/Vite frontend.
3. Define secure server-side session or token verification.
4. Define the mapping from verified WorkOS provider/subject identity to
   internal Pulse Metrics users.
5. Preserve provider-independent internal user records.
6. Implement authentication and trusted server-side user identity.
7. Implement organization provisioning and membership administration.
8. Enforce organization roles and permissions in server-side operations.
9. Authenticate browser-facing WebSocket connections.
10. Authorize organization subscriptions and prevent cross-tenant event
    delivery.
11. Add automated tests for authenticated and unauthorized API and
    WebSocket access.
12. Review session security, account lifecycle and recovery behavior.

Do not treat WorkOS authentication as a replacement for Pulse Metrics
authorization. The application must continue to verify internal organization
membership and permissions before granting access to customer resources.

After the human identity and organization authorization foundation is
verified, proceed to secure agent enrollment:

- One-time enrollment tokens.
- Hashed token storage.
- Token expiry and single-use enforcement.
- Authenticated agent credential issuance.
- Credential rotation and revocation.
- A separate authenticated machine communication channel.
- Authenticated telemetry ingestion.
- Per-organization agent authorization.

Do not move customer onboarding into production until the complete
authentication, authorization, WebSocket security, enrollment, telemetry and
operational security requirements have been implemented and reviewed.

## 8. Project health statement

**Current stage:** Commercial database foundation implemented; repeatable
tenant-isolation integration testing completed; authentication and real-time
security architecture documented.

**Human authentication provider:** WorkOS AuthKit selected; integration
pending.

**Application authorization:** Owned by Pulse Metrics; implementation
incomplete.

**WebSockets:** Retained for real-time monitoring; authentication and
organization authorization not implemented.

**Agent authentication:** Separate machine identity architecture accepted;
implementation pending.

**Production readiness:** Not achieved.

**Public customer onboarding:** Not permitted yet.

**Next priority:** Review and implement WorkOS authentication, trusted
server-side identity, organization access controls and authenticated,
organization-scoped WebSockets before proceeding to secure agent enrollment.
