# Pulse Metrics — Architecture Decisions

**Document status:** Active
**Last reviewed:** 2026-11-07

This document records significant architectural choices and the reasoning
behind them. It is not a substitute for implementation or security testing.

## ADR-001 — Commercial multi-tenant SaaS architecture

**Status:** Accepted

Pulse Metrics is being designed as a commercial multi-tenant service rather
than a personal monitoring dashboard.

Consequences:

- Customer data must be scoped to organizations.
- Authorization must be enforced server-side.
- Tenant isolation must be tested at the database and application layers.
- Billing, plan limits, auditability and retention must be designed into the
  product as it matures.

## ADR-002 — PostgreSQL as the primary relational database

**Status:** Accepted

PostgreSQL is the primary persistent database.

Drizzle ORM is used for application schema definitions and migrations.

Consequences:

- Schema changes must be migration-controlled.
- Migrations must be reviewed before application.
- Production migration access must be separated from runtime access.
- Database constraints should enforce important data invariants.

## ADR-003 — Separate database runtime and migration roles

**Status:** Accepted

The application runtime uses `pulse_metrics_app`.
Schema migrations use `pulse_metrics_migrator`.

The runtime role must not own application tables, create schema objects,
or receive migration privileges.

Sensitive credential and enrollment tables are not accessible to the ordinary
runtime role under the current grant model.

Consequences:

- Never put migration credentials in the running API configuration.
- Never broaden runtime grants merely to make an endpoint work.
- Future provisioning and credential operations require separately scoped,
  reviewed database access patterns.

## ADR-004 — PostgreSQL row-level security

**Status:** Accepted; initial verification passed, broader review ongoing

Tenant-owned tables use PostgreSQL row-level security. RLS is enabled and
forced on the eight initial application tables.

The application also applies tenant context within transactions.

Important security qualification:

PostgreSQL custom settings such as `app.current_organization_id` are context
values, not unforgeable identities. They do not protect against arbitrary SQL
execution by a compromised database role.

Therefore:

- Authenticate users independently.
- Derive user identity from trusted server-side authentication.
- Verify organization membership before setting tenant context.
- Use parameterized queries.
- Keep runtime privileges minimal.
- Never treat RLS context values as a replacement for application
  authentication or authorization.

## ADR-005 — Transaction-scoped tenant context

**Status:** Accepted; initial transaction-context tests passed, broader testing ongoing

Tenant context is set using transaction-local PostgreSQL settings.

The helper clears organization context, sets the authenticated user context,
verifies membership, then sets organization context before tenant queries.

Consequences:

- Tenant-scoped queries must run inside the helper's transaction callback.
- Do not set tenant context at pool/session scope.
- Do not accept a browser-supplied user ID as proof of identity.
- Test connection reuse and context cleanup.

## ADR-006 — Outbound authenticated monitoring agents

**Status:** Accepted as the intended direction

Monitoring agents should initiate authenticated outbound communication with
the Pulse Metrics service.

Customers should not need to expose inbound monitoring ports for routine
telemetry collection.

Agent credentials must be scoped, revocable and securely stored.

## ADR-007 — Genuine telemetry only

**Status:** Accepted

The product must not present simulated values as real measurements.

Missing, stale, invalid and unavailable values must be represented honestly.
Demonstration data must be visibly identified.

## ADR-008 — Avoid unrestricted browser-to-shell execution

**Status:** Accepted

Browser-accessible arbitrary shell execution is not an acceptable general
customer capability.

Any future remote administration or command execution feature requires
a separate threat model, strict authorization, constrained operations,
auditing and explicit security review.

## ADR-009 — Incremental infrastructure

**Status:** Accepted

Start with the existing Node application, PostgreSQL and Drizzle foundation.

Do not introduce Redis, Kubernetes or other infrastructure without a
demonstrated requirement.

The architecture should evolve based on measured needs rather than
unnecessary complexity.

## ADR-010 — Standalone local Linux collector and runner

**Date:** 2026-11-07
**Status:** Accepted

The initial Linux telemetry collector and sampling engine are implemented
as components independent of the Express dashboard server. A standalone
runner starts the collector, validates versioned telemetry envelopes and
writes structured sample output to the local terminal.

The current runner is a local development tool. It does not enroll an agent,
authenticate to a customer organization, transmit telemetry to the SaaS
service, or persist telemetry in the application database.

The initial collector reads genuine local Linux measurements, including CPU
counters, CPU core count and load averages, memory, swap, root filesystem
capacity, cumulative network byte counters and system uptime.

Consequences:

- Local collection can be developed and tested independently from the web
  application.
- The collector and sampler must not acquire arbitrary shell or SSH execution
  capabilities.
- Invalid telemetry envelopes must be rejected before being reported.
- Unavailable measurements must remain explicitly unavailable rather than
  being replaced with fabricated values.
- The runner must stop scheduling new samples and allow an in-flight sample
  to finish during graceful shutdown.
- No customer telemetry may be sent to the SaaS service until authenticated
  agent enrollment, credential verification, tenant authorization and the
  ingestion endpoint are implemented and tested.
- Network counters currently represent cumulative bytes. The current
  non-loopback aggregate may double-count virtual or bridged interfaces;
  meaningful network rates and interface attribution require further design.
- CPU load averages must not be mislabeled as CPU utilization.

This decision records the local development boundary. It does not declare the
agent protocol, enrollment system or remote ingestion architecture complete.

## Decision process

For a significant new decision, record:

- Decision identifier and date.
- Context and problem.
- Chosen approach.
- Alternatives considered.
- Security and operational consequences.
- Status: proposed, accepted, superseded or rejected.

When a decision changes, preserve the historical record and explain the
replacement.
