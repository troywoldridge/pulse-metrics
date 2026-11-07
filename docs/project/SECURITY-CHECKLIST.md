# Pulse Metrics — Security Checklist

**Document status:** Active
**Last reviewed:** 2026-11-07

This checklist defines security requirements for a commercial multi-tenant
monitoring service.

A checked item must have implementation and verification evidence. A design
decision or code change alone is not sufficient.

## 1. Identity and authentication

- [ ] Secure registration and account verification.
- [ ] Secure login and session handling.
- [ ] Session expiration and revocation.
- [ ] Secure password handling if passwords are managed locally.
- [ ] Protection against brute-force login attempts.
- [ ] Trusted server-side identity for every protected request.
- [ ] No reliance on browser-supplied user IDs as authentication.
- [ ] Appropriate account recovery procedures.
- [ ] Security-sensitive authentication events audited.

## 2. Authorization and organization isolation

- [x] Initial organization and membership schema exists.
- [x] Initial tenant RLS policies exist.
- [x] RLS is enabled and forced on the eight initial application tables.
- [x] Runtime role does not have RLS bypass.
- [x] Tenant-context helper verifies membership before setting organization.
- [x] Initial cross-tenant integration test passed.
- [x] Invalid UUID tests for organization and user context.
- [x] Nonexistent-user and nonexistent-organization access tests.
- [x] Missing and revoked membership tests.
- [x] Transaction-local tenant-context cleanup and single-connection reuse test.
- [x] Repeatable tenant-isolation integration command; passed twice.
- [ ] Authorization tests for every customer-facing API.
- [ ] Organization role and permission matrix.
- [ ] Cross-tenant tests for every tenant-owned resource.
- [ ] Review for insecure direct object references.

## 3. Database and data access

- [x] Separate runtime and migration database roles.
- [x] Runtime role is not a superuser.
- [x] Runtime role has no RLS bypass.
- [x] Runtime role cannot create schema objects.
- [x] Sensitive credential and enrollment tables denied to runtime role.
- [x] Audit and telemetry update/delete/truncate denied to runtime role.
- [ ] Production database TLS and certificate verification.
- [ ] Production secret management and rotation.
- [ ] Review all database grants after schema changes.
- [ ] Review all RLS policies as tables and endpoints are added.
- [ ] Backup encryption and restore testing.
- [ ] Data retention and deletion enforcement.
- [ ] Protection against SQL injection.
- [ ] Database connection and query resource limits.

## 4. Agent enrollment and credentials

- [ ] One-time enrollment token generation.
- [ ] Store enrollment tokens as secure hashes.
- [ ] Token expiration and single-use enforcement.
- [ ] Organization-scoped enrollment authorization.
- [ ] Secure agent credential issuance.
- [ ] Credential verification.
- [ ] Credential rotation.
- [ ] Credential revocation.
- [ ] Prevent credential exposure in logs and API responses.
- [ ] Prevent agent identity spoofing.
- [ ] Reject telemetry from revoked agents.
- [ ] Protect against replay and duplicate enrollment.
- [ ] Document secure agent installation and updates.

## 5. Telemetry ingestion

- [ ] Authenticate every agent submission.
- [ ] Verify agent and organization ownership.
- [ ] Validate payload schemas and versions.
- [ ] Enforce payload size and rate limits.
- [ ] Validate numeric ranges and timestamps.
- [ ] Reject malformed and unauthorized submissions.
- [ ] Prevent cross-tenant telemetry insertion.
- [ ] Handle retries and duplicate submissions safely.
- [ ] Prevent stale or unavailable measurements from appearing current.
- [ ] Avoid storing unnecessary sensitive process or system information.

## 6. Local Linux collector development boundary

These items describe the local development collector only. They do not
constitute authenticated agent security or authorize customer telemetry
submission.

- [x] Initial Linux collector reads genuine local operating-system metrics.
- [x] Versioned telemetry envelope and schema validation are implemented.
- [x] Missing CPU baseline is represented as unavailable, not fabricated.
- [x] Sampler prevents overlapping collections.
- [x] Standalone runner emits local terminal output only.
- [x] Runner does not submit telemetry to a remote endpoint or database.
- [x] Verify graceful SIGINT (Ctrl+C) shutdown manually.
- [ ] Verify graceful SIGTERM shutdown manually.
- [x] Rerun lint and the full automated test suite after runner changes.
- [x] Verify the production build after runner changes.
- [ ] Resolve network interface aggregation and rate semantics before
  presenting network values as per-device rates.

Agent authentication, enrollment, credential management and remote telemetry
ingestion remain mandatory future security work.

## 7. API and WebSocket security

- [ ] Inventory all API endpoints.
- [ ] Require authentication for protected endpoints.
- [ ] Enforce authorization on every resource operation.
- [ ] Validate request parameters and bodies.
- [ ] Apply rate limits and abuse controls.
- [ ] Apply appropriate CORS and browser security policy.
- [ ] Secure WebSocket authentication and authorization if retained.
- [ ] Remove or constrain arbitrary shell execution.
- [ ] Prevent browser-controlled commands from reaching SSH or a shell.
- [ ] Audit privileged operations.
- [ ] Return safe errors without leaking secrets or internals.

## 8. Application and infrastructure

- [ ] TLS for all public application traffic.
- [ ] Secure headers and cookie settings.
- [ ] Dependency vulnerability review.
- [ ] Secret scanning and safe configuration.
- [ ] Least-privilege operating-system service accounts.
- [ ] Network exposure review.
- [ ] Secure deployment and rollback procedures.
- [ ] Application and agent update security.
- [ ] Resource limits and denial-of-service protections.

## 9. Audit, privacy and operations

- [ ] Audit authentication and authorization events.
- [ ] Audit agent enrollment, revocation and sensitive administration.
- [ ] Protect audit records from ordinary application modification.
- [ ] Define customer data retention.
- [ ] Define customer data export and deletion.
- [ ] Minimize collection of personal and sensitive data.
- [ ] Define incident response procedures.
- [ ] Define backup and disaster recovery procedures.
- [ ] Test restoration.
- [ ] Document security contact and vulnerability reporting process.

## Security release gate

Public launch is blocked until all mandatory security requirements are
implemented, tested and reviewed. Critical and high-severity findings must
be resolved before customer onboarding.

The current database checks are a foundation, not a complete security audit.
