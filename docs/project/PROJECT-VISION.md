# Pulse Metrics — Project Vision

**Document status:** Active
**Last reviewed:** 2026-11-07

## 1. Product vision

Pulse Metrics is intended to become a commercially available, secure,
multi-tenant infrastructure monitoring platform.

Customers will use Pulse Metrics to monitor the health and performance of
their own servers and devices through authenticated monitoring agents and a
centralized web application.

The objective is to provide useful, accurate and understandable infrastructure
visibility without requiring customers to expose their systems to unsolicited
inbound connections.

Pulse Metrics is a monitoring service, not simply a dashboard displaying
server statistics.

## 2. The customers we intend to serve

The product should be designed for organizations and individuals who need
reliable visibility into infrastructure they own or are authorized to manage.

Potential customer groups include:

- Small businesses managing their own servers.
- Web developers and hosting operators.
- IT service providers and managed service providers.
- Organizations with multiple servers or monitored environments.
- Technical users who want understandable infrastructure monitoring.

These are intended markets, not claims about an existing customer base.

## 3. The product experience

Customers should ultimately be able to:

- Register and securely manage an account.
- Create or join an organization.
- Invite other authorized members.
- Enroll monitoring agents on supported systems.
- See which devices are online, offline or experiencing problems.
- View genuine CPU, memory, disk, network and system measurements.
- Review historical telemetry and trends.
- Configure alerts and notifications.
- Manage devices, users and organization permissions.
- Select a subscription appropriate to their needs.
- Manage billing, plan limits and account settings.

The product should make monitoring information clear and trustworthy.
Missing measurements must be identified as unavailable rather than replaced
with invented values.

## 4. Core product principles

### Accuracy before appearance

Measurements must represent actual observations. Demonstration data must be
clearly identified. Errors and unavailable measurements must never be presented
as healthy or genuine readings.

### Security by design

Tenant isolation, authentication, authorization, credential management and
least privilege must be considered foundational requirements.

### Customer ownership and isolation

A customer must only access organizations, devices, telemetry and resources
they are authorized to access.

### Outbound agent communication

The intended agent architecture uses authenticated outbound connections to
the Pulse Metrics service. Customers should not need to expose inbound
monitoring ports to the public internet.

### Reliability

The service must handle disconnections, delayed telemetry, invalid data,
restarts and temporary network failures gracefully.

### Honest operation

The application must distinguish live data, historical data, stale data,
missing data and errors.

### Commercial scalability

The architecture must support multiple independent customers, subscription
limits, organization membership, auditability and future growth.

## 5. Commercial direction

Pulse Metrics is intended to operate as a subscription-based SaaS product.

The commercial platform is expected to include:

- Free or trial access, subject to a finalized business model.
- Paid subscription plans.
- Device or agent limits.
- Account and organization management.
- Billing and subscription lifecycle management.
- Usage visibility and plan enforcement.
- Customer onboarding and support processes.

Exact prices, plan names, limits, retention periods and billing rules have not
yet been finalized. They must be documented before implementation.

## 6. Intended platform evolution

The initial implementation focuses on a secure web service, PostgreSQL and
Linux monitoring agents.

Future platform work may include:

- Windows agents.
- macOS agents.
- Additional integrations.
- Advanced alerting and reporting.
- Organization-level operational controls.
- Customer-facing API access.
- More advanced automation.

These are future capabilities, not current features.

## 7. What Pulse Metrics must not become

- A service that executes arbitrary shell commands supplied by browser users.
- A multi-tenant application that trusts organization IDs supplied by clients.
- A monitoring dashboard that presents simulated readings as real.
- A system that stores agent credentials in plaintext.
- A product that exposes customer infrastructure unnecessarily.
- A platform that treats a successful build as proof of production security.

## 8. Definition of success

Pulse Metrics will be ready for public commercial launch only when customers
can securely create and manage accounts, enroll authorized agents, receive
genuine telemetry, view isolated monitoring data, manage their subscriptions,
and rely on documented operational and security controls.

The platform must also have appropriate testing, backups, recovery procedures,
monitoring, support processes and production deployment controls.
