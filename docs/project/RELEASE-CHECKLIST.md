# Pulse Metrics — Production and Public Release Checklist

**Document status:** Active
**Last reviewed:** 2026-11-07

This checklist is the release gate for operating Pulse Metrics as a public
commercial service. Items must be verified in the intended release
environment.

## 1. Product and customer experience

- [ ] Product scope and supported platforms documented.
- [ ] Customer registration and onboarding complete.
- [ ] Organization and membership management complete.
- [ ] Agent installation and removal documented.
- [ ] Device and telemetry views complete.
- [ ] Loading, empty, offline, stale and error states accurate.
- [ ] Customer support and troubleshooting documentation available.
- [ ] Accessibility and usability review completed.

## 2. Authentication and authorization

- [ ] Authentication implemented and independently reviewed.
- [ ] Session lifecycle and revocation verified.
- [ ] Organization roles and permissions verified.
- [ ] Tenant isolation tested across all customer resources.
- [ ] No insecure direct object reference findings remain.
- [ ] Administrative access is restricted and audited.

## 3. Agent security

- [ ] Secure one-time enrollment verified.
- [ ] Credentials stored securely.
- [ ] Credential rotation and revocation verified.
- [ ] Unauthorized and revoked agents rejected.
- [ ] Agent-to-organization binding verified.
- [ ] Outbound communication protected by TLS.
- [ ] Agent update and installation security reviewed.

## 4. Telemetry accuracy

- [ ] CPU readings verified against actual system measurements.
- [ ] Memory readings verified.
- [ ] Disk readings verified.
- [ ] Network measurements verified.
- [ ] Timestamps and freshness verified.
- [ ] Offline and stale agents represented accurately.
- [ ] Missing and invalid measurements never presented as genuine values.
- [ ] Historical data and retention behavior verified.

## 5. Database and data protection

- [ ] Production database roles reviewed.
- [ ] RLS policies reviewed and tested.
- [ ] Production TLS and certificate verification enabled.
- [ ] Database backups configured.
- [ ] Database restoration successfully tested.
- [ ] Retention and deletion procedures tested.
- [ ] Secrets stored and rotated securely.
- [ ] Audit events protected and reviewable.

## 6. Application and infrastructure

- [ ] API authentication and authorization reviewed.
- [ ] Rate limiting and abuse controls enabled.
- [ ] Arbitrary shell execution unavailable to unauthorized users.
- [ ] WebSocket security reviewed or unnecessary functionality removed.
- [ ] TLS and secure headers configured.
- [ ] Dependency vulnerabilities reviewed.
- [ ] Logs do not contain secrets or unnecessary sensitive data.
- [ ] Health checks and operational alerts configured.
- [ ] Capacity and performance tested.
- [ ] Deployment and rollback tested.

## 7. Commercial operations

- [ ] Subscription plans and prices finalized.
- [ ] Billing provider integration tested.
- [ ] Billing webhooks authenticated and idempotent.
- [ ] Plan limits enforced server-side.
- [ ] Trial, cancellation and failed-payment behavior tested.
- [ ] Customer invoices and billing information available.
- [ ] Terms of service and privacy policy reviewed.
- [ ] Customer support process operational.
- [ ] Data retention and account deletion policies documented.

## 8. Final release approval

- [ ] Unit and integration suites pass.
- [ ] Production build passes.
- [ ] End-to-end acceptance tests pass.
- [ ] Security review completed.
- [ ] Critical and high-severity security findings resolved.
- [ ] Backup and recovery verified.
- [ ] Monitoring and incident response operational.
- [ ] Release and rollback plan approved.

## Release decision

Public launch must not proceed merely because the application builds or the
dashboard appears to work.

The release owner must review evidence for all mandatory requirements and
record the release decision, date, version and any explicitly accepted risks.
