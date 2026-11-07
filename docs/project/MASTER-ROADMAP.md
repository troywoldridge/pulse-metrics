# Pulse Metrics — Master Development Roadmap

**Document status:** Active
**Last reviewed:** 2026-11-07
**Product direction:** Commercial Infrastructure Monitoring, Diagnostics & IT Intelligence SaaS

This roadmap defines the development path from the current prototype and
database foundation to a commercially operated, multi-tenant infrastructure
monitoring and IT diagnostics platform.

Pulse Metrics will initially provide reliable infrastructure monitoring.
Once that foundation is secure and proven, the platform will expand into
IT diagnostics, guided troubleshooting and intelligent infrastructure
insights.

The roadmap is intentionally phased. Features must not be rushed ahead of
their security, reliability or architectural dependencies.

## Product vision

Pulse Metrics aims to help businesses, IT professionals and managed service
providers:

- Monitor infrastructure from a centralized dashboard.
- Understand the actual health and performance of monitored devices.
- Detect problems before they become major incidents.
- Investigate infrastructure and service problems.
- Receive understandable explanations and troubleshooting guidance.
- Make informed decisions using reliable historical measurements.

The long-term product is more than a metrics dashboard. It is an
infrastructure monitoring and IT intelligence platform.

## Core architectural principles

Every phase must follow these principles:

1. **Multi-tenant security:** Customer organizations must be isolated at
   every application, API and database boundary.
2. **Authenticated identity:** Users, organizations and agents must have
   independently verified identities.
3. **Least privilege:** Application users, agents and services receive only
   the permissions they require.
4. **Real measurements:** Fabricated, random or estimated values must never
   be presented as genuine system measurements.
5. **Secure agent communication:** Agents initiate outbound authenticated
   connections. Customers should not need to expose inbound management ports.
6. **No unrestricted remote shell:** The customer dashboard must not execute
   arbitrary commands on monitored devices.
7. **Privacy by design:** Collect only information required for the product
   and its explicitly enabled features.
8. **Auditable operations:** Sensitive account, agent, diagnostic and
   administrative actions must be traceable.
9. **Reliability:** Missing, stale, invalid and unavailable data must be
   represented honestly.
10. **Test before release:** Security, tenant isolation and failure behavior
    must be verified, not merely assumed.

## Phase 1 — Commercial foundation and database security

**Status: In progress — database foundation implemented; further verification
and application integration remain.**

Objectives:

- Establish PostgreSQL as the persistent application database.
- Establish separate migration and runtime database roles.
- Implement the organization and membership model.
- Implement agent, credential, enrollment, telemetry and audit data
  structures.
- Enable and force row-level security on tenant tables.
- Establish transaction-scoped tenant context.
- Restrict application database permissions.
- Establish repeatable database migrations and verification.
- Document the security boundaries expected of the application.

Completion criteria:

- Database migrations apply cleanly to a fresh supported database.
- Runtime and migration roles have documented, separate privileges.
- Tenant isolation is tested using the restricted application role.
- Cross-organization access is denied.
- Sensitive credential and enrollment tables are inaccessible to the
  ordinary application role.
- Tenant context does not leak between pooled transactions.
- Database tests and documentation agree with the actual schema and policies.
- Database backup and migration procedures are documented.

## Phase 2 — Authentication, identity and authorization

**Status: Planned**

Objectives:

- Select and document the authentication architecture.
- Implement secure registration and login.
- Implement session creation, validation, expiration and revocation.
- Connect authenticated identities to internal user records.
- Implement organization creation and membership management.
- Implement organization roles and permission checks.
- Ensure organization identity is derived from trusted server-side context.
- Add safe organization provisioning and membership administration.
- Record security-sensitive account and membership events.
- Protect API routes and dashboard data from unauthorized access.

Completion criteria:

- Unauthenticated requests cannot access protected resources.
- Users cannot impersonate another user or organization by changing request
  parameters.
- Organization membership and role permissions are enforced server-side.
- Session lifecycle and revocation behavior are tested.
- Security-sensitive operations are auditable.
- WebSocket connections, if used, have authenticated and authorized access.

## Phase 3 — Agent enrollment and credential infrastructure

**Status: Planned**

Objectives:

- Define a versioned, authenticated agent communication protocol.
- Implement one-time enrollment tokens.
- Store enrollment tokens securely as hashes.
- Implement credential issuance, storage and verification.
- Support credential rotation and revocation.
- Bind each agent to its authorized organization.
- Prevent duplicate, unauthorized or replayed enrollment.
- Define agent identity, status and lifecycle states.
- Establish secure outbound agent communication.
- Define agent version and supported capability reporting.
- Establish resource limits and safe collection permissions.

Completion criteria:

- Only authorized enrollment can create an active agent identity.
- Enrollment tokens cannot be reused after successful consumption.
- Credentials are never exposed through ordinary customer APIs.
- Revoked agents cannot continue authenticated telemetry submission.
- Agents cannot submit data for another organization's devices.
- Agent communication is encrypted and authenticated.
- Agent installation and removal procedures are documented.

## Phase 4 — Real telemetry collection and ingestion

**Status: In progress — initial local Linux collection, telemetry contract,
sampler and standalone local runner implemented; authenticated enrollment,
ingestion and persistence remain outstanding.**

The initial collector and runner are development components only. They read
local Linux operating-system counters and emit validated telemetry to the
local terminal. They do not enroll with a customer organization, authenticate
to the SaaS service, transmit telemetry, or persist samples.

Phase 4 depends on the identity and credential foundations in Phases 2 and 3
before customer telemetry can be accepted by the SaaS platform. Local
collector development may proceed in parallel, but it does not bypass those
dependencies.

Objectives:

- Build the initial Linux monitoring agent.
- Collect genuine CPU measurements.
- Collect memory and disk measurements.
- Collect filesystem capacity and utilization.
- Collect network counters and calculate meaningful rates.
- Collect selected system and process information safely.
- Collect operating system, kernel and uptime information.
- Add timestamps and telemetry schema versions.
- Authenticate and validate telemetry submissions.
- Persist telemetry with tenant and agent identity.
- Handle offline agents, delayed data and network failures.
- Distinguish missing, stale and invalid measurements.
- Remove prototype-only simulated telemetry and hardcoded host assumptions.
- Remove SSH-based customer monitoring and arbitrary remote command execution.
- Preserve useful dashboard components while replacing their data sources.

Completion criteria:

- Telemetry originates from real system measurements.
- Incoming data is validated before persistence.
- Agent identity and organization ownership are verified.
- Invalid or unauthorized submissions are rejected.
- Collection failures do not produce fabricated healthy readings.
- Reconnection and retry behavior is tested.
- No simulated values are presented as genuine telemetry.
- The monitoring architecture does not depend on customer SSH access.
- Agent permissions and collection scope are documented.

## Phase 5 — Customer dashboard and core monitoring experience

**Status: Planned**

Objectives:

- Connect the React interface to authenticated APIs.
- Display organization-specific monitored devices.
- Display current and historical measurements.
- Display online, offline and stale status accurately.
- Show telemetry timestamps and freshness.
- Provide useful device detail views.
- Support organization and device management.
- Provide useful empty, loading, error and unavailable states.
- Retain and improve reusable dashboard widgets and visualizations.
- Provide device search, filtering and sorting as appropriate.
- Make the dashboard useful on desktop and mobile displays.

Completion criteria:

- Dashboard data comes from authorized backend queries.
- Customer views remain tenant-isolated.
- Live status reflects actual agent communication.
- Historical views use persisted telemetry.
- No simulated values are presented as live measurements.
- Dashboard failures and stale data are clearly communicated.
- Customer-facing device actions are authorized and auditable.

## Phase 6 — Alerts, notifications and reporting

**Status: Planned**

Objectives:

- Define configurable alert rules.
- Evaluate telemetry against thresholds and conditions.
- Detect agent disconnections and missing telemetry.
- Avoid duplicate or excessive notifications.
- Implement alert lifecycle and acknowledgment.
- Provide notification preferences.
- Add useful historical reports and summaries.
- Record relevant alert events for audit and troubleshooting.
- Support configurable alert severity and notification channels.

Completion criteria:

- Alert rules are organization-scoped and authorized.
- Alert evaluation is reliable and testable.
- Duplicate alert behavior is controlled.
- Notifications are delivered safely.
- Alert history is accurate and traceable.
- Customers can configure and manage their alert preferences.

## Phase 7 — IT diagnostics and troubleshooting

**Status: Planned — major product expansion after core monitoring is reliable.**

This phase expands Pulse Metrics from monitoring infrastructure into helping
IT professionals understand why problems occur.

Objectives:

- Design a permission-controlled diagnostic framework.
- Define named, documented and versioned diagnostic checks.
- Add disk capacity and filesystem diagnostics.
- Add CPU and memory pressure analysis.
- Add network connectivity and DNS diagnostics.
- Add service and process health checks.
- Add selected operating system and system-log analysis.
- Add hardware health checks where supported.
- Add SMART storage health reporting where supported.
- Identify package updates and relevant system maintenance information.
- Present diagnostic results with timestamps, severity and supporting evidence.
- Provide clear explanations and recommended next steps.
- Allow customers to control which diagnostic capabilities are enabled.

Completion criteria:

- Diagnostic checks are explicitly defined and allowlisted.
- Checks run with least privilege and appropriate resource limits.
- Diagnostic access is organization- and agent-authorized.
- Results are validated, timestamped and stored safely.
- Diagnostic failures are distinguished from successful checks.
- Sensitive system information is not unnecessarily exposed.
- No arbitrary browser-to-shell or unrestricted remote command execution
  is introduced.
- Diagnostic activity is auditable and customer-controlled.

## Phase 8 — Intelligent troubleshooting and infrastructure insights

**Status: Planned — dependent on reliable monitoring and diagnostic data.**

Objectives:

- Provide plain-English explanations of infrastructure measurements.
- Identify unusual behavior and potential causes.
- Correlate related telemetry and diagnostic results.
- Generate incident summaries.
- Provide guided troubleshooting procedures.
- Recommend preventative maintenance.
- Identify trends and potential capacity problems.
- Explore anomaly detection and predictive warnings.
- Provide AI-assisted interpretation of diagnostic evidence.
- Keep customers informed about uncertainty and confidence limitations.

Completion criteria:

- Recommendations are grounded in actual measurements and diagnostic
  evidence.
- AI-generated explanations distinguish facts from possible causes.
- Missing or insufficient data is disclosed.
- Recommendations are auditable and traceable to supporting evidence.
- AI cannot independently execute remediation commands.
- Any future remediation capability requires explicit authorization,
  narrowly defined actions and additional security review.

## Phase 9 — Commercial accounts, plans, billing and integrations

**Status: Planned**

Objectives:

- Finalize the commercial pricing and plan model.
- Select a payment and subscription provider.
- Implement checkout and subscription lifecycle handling.
- Implement customer billing management.
- Enforce subscription limits server-side.
- Define trial, cancellation, failed-payment and renewal behavior.
- Define telemetry retention and plan-specific limits.
- Provide clear usage and billing information.
- Add team management and appropriate organization roles.
- Explore customer API and integration credentials.
- Consider integrations with external IT and infrastructure services.
- Evaluate Windows and macOS monitoring agents.
- Expand monitoring capabilities based on customer needs.

Completion criteria:

- Billing events are verified and handled idempotently.
- Subscription state is authoritative and secure.
- Plan restrictions are enforced by the backend.
- Customers can understand and manage their subscriptions.
- Billing failures do not grant unauthorized access or silently corrupt state.
- Integration credentials are protected and revocable.
- Additional agents and integrations follow the same security standards.

## Phase 10 — Production engineering, operational readiness and public launch

**Status: Planned — production requirements must be addressed throughout
development, not deferred until launch.**

Objectives:

- Define production infrastructure and deployment architecture.
- Establish secret management and key rotation.
- Enforce TLS and secure network configuration.
- Implement centralized application and agent logging.
- Implement service health monitoring and operational alerting.
- Establish database backup and tested restoration.
- Define disaster recovery procedures.
- Implement rate limiting and abuse protection.
- Conduct load, concurrency and resource testing.
- Establish dependency and vulnerability management.
- Define data retention and deletion procedures.
- Prepare incident response and operational runbooks.
- Complete customer onboarding documentation.
- Complete agent installation and troubleshooting documentation.
- Complete privacy, terms and support documentation.
- Validate billing and account lifecycle end to end.
- Run production acceptance tests.
- Establish customer support and rollback procedures.

Completion criteria:

- Production configuration is documented and reviewed.
- Backups and restoration have been tested.
- Operational failures can be detected and investigated.
- Capacity and performance have been evaluated.
- Security and privacy requirements have evidence of verification.
- Customer isolation and agent authorization have been verified.
- No unresolved critical or high-severity security issues remain.
- Release checklist requirements are satisfied.
- The service is ready to accept real customers.

## Deferred features and scope boundaries

The following features are intentionally not part of the immediate monitoring
foundation:

- Arbitrary remote shell execution through the dashboard.
- Customer-facing SSH connection management.
- Unrestricted remote terminal access.
- Automatic remediation that changes customer systems without approval.
- AI-generated actions that execute without explicit authorization.
- Large collections of diagnostic checks before the agent security model is
  established.
- Additional operating system agents before the initial Linux agent is
  reliable.
- Advanced integrations before authentication, tenant isolation and
  credential management are proven.

These boundaries may be reconsidered through documented architecture
decisions and appropriate security review.

## Current development priorities

The immediate work sequence is:

1. Preserve and verify the PostgreSQL security foundation and its repeatable
   tenant-isolation tests.
2. Complete the local Linux agent runner verification, including graceful
   shutdown, lint, unit tests and a production build.
3. Refine telemetry semantics and collection accuracy, especially network
   interface accounting and the distinction between cumulative byte counters
   and transfer rates.
4. Complete Phase 2 authentication, trusted identity and organization access.
5. Complete Phase 3 secure agent enrollment, credential issuance, rotation
   and revocation.
6. Implement authenticated, tenant-authorized telemetry ingestion and
   persistence.
7. Remove prototype-only simulated telemetry, hardcoded host assumptions,
   SSH-based monitoring and arbitrary remote command execution from the
   customer-facing application.
8. Connect the dashboard to real, tenant-authorized persisted telemetry.
9. Test the complete monitoring workflow before expanding functionality.

Local Linux collection is now implemented as an initial development
foundation. It is not a substitute for authenticated agent enrollment or
SaaS ingestion. The current prototype must not be treated as production-ready
simply because the dashboard renders, refreshes or a local collector emits
readings. Real telemetry, authenticated access, tenant isolation and failure
handling must all be independently verified.

## Roadmap change control

Changes to scope, phase order or architecture must be recorded in
ARCHITECTURE-DECISIONS.md where they represent a significant technical
decision, and reflected in CURRENT-STATUS.md and this roadmap.

Phase completion must be based on demonstrated implementation and verification,
not intention or visual appearance.

A phase may be marked complete only when its completion criteria have been
satisfied and supporting tests or review evidence are available.
