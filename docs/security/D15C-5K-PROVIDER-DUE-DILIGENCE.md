# D15C-5K — Self-Hosted and Cloud-Fallback Security Evidence Checklist

**Evidence state:** PROPOSED / NOT VERIFIED. Local diagnostic outputs justify an assessment, not a customer launch. These checkboxes are intentionally unmarked.

## Existing-server isolation and exposure

- [ ] Existing website and background worker protected by tested backup and independent rollback plan.
- [ ] Dedicated Pulse Metrics Linux service identity; least-privilege FS paths, no existing web app or database credentials reused.
- [ ] Process resource limits, CPU/disk contention, reboot behavior and update/restart impact measured with synthetic telemetry.
- [ ] IPv4, IPv6, router forwarding, UFW, Nginx, cloud tunnel, admin ports and obsolete firewall rules independently reviewed.
- [ ] Network-exposed PostgreSQL client access limited to justified addresses or local-only; stale source removed after dependency review.
- [ ] Actual PostgreSQL authentication/authorization verified, not inferred from a successful SSH forwarded TCP port.
- [ ] Local Unix-domain-socket authentication or remote certificate/hostname-verified TLS verified for intended application connection.
- [ ] UPS, ISP/fiber outage response, safe shutdown and external monitoring reviewed.

## Data and independent evidence

- [ ] Separate Pulse Metrics database with migration/runtime identities, no shared privileged admin role.
- [ ] FORCE RLS and cross-tenant access denial tested under restricted role; pooled transaction tenant context cannot leak.
- [ ] Credentials/enrollment and maintenance functions inaccessible to ordinary runtime account.
- [ ] Daily encrypted offsite backups and isolated restore verified; RTO/RPO and retention defined.
- [ ] Independent audit custody outside this physical host, independently administered, immutability and rollback/deletion tested.
- [ ] Workload credentials/keys separately scoped, rotated and revoked; signatures tied to verifiable operator identity and current authorization.
- [ ] Durable shared nonce/outbox semantics validated under concurrency and crash-restart; no automatic ambiguous delivery replay.
- [ ] Tenant data export, deletion, telemetry privacy and legal retention policy independently reviewed.

## Optional future cloud relocation

- [ ] Provider account/region, real quote, budget cap and role privileges reviewed before purchase.
- [ ] Managed PostgreSQL TLS verification, FORCE RLS grants and PITR restored in disposable staging, not inferred from docs.
- [ ] Separate external custody security domain, signer lifecycle and cost verified.

## Release barrier

All **16 D15C-5J release gates** retain external verification requirements. This file records questions to prove; passing 5K unit tests is not evidence of these outcomes. No public customers, real operator permissions, alert dispatch or scheduler are authorized.
