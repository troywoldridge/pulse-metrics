# ADR-011 — Conditional Self-Hosted Private Pilot and Cloud Fallback

**Date:** 2026-11-14
**Status:** PROPOSED / NOT ACCEPTED — local investigation only
**Dependencies:** ADR-009 incremental infrastructure; proposed ADR-010; 16 unverified D15C-5J release gates
**Public launch:** NO_GO

## Context

Pulse Metrics is a commercial multi-tenant monitoring and IT diagnostics SaaS. It needs authenticated outbound telemetry agents, trustworthy readings, tenant isolation, restrictive database permissions and independent audit evidence. The developer now has access to existing owner-operated Ubuntu hardware with low current utilization. This makes paid cloud compute optional for an early **noncustomer** pilot but does not eliminate the need for security and reliability controls.

The machine is shared with an existing website and background valuation worker. It is a single physical host and location: an application crash, disk fault, power loss, compromise, router failure or fiber outage can affect both businesses. Simply creating separate databases or Unix users does not give physical independence.

## Candidate preference (conditional, no approval)

**First evaluate the owner's existing server as a controlled private pilot host**, without any public customers or external alert dispatch. This is a hosting hypothesis, NOT a decision to migrate, install, grant database privileges or activate a process.

Operator-supplied observations (not independently benchmarked): Ubuntu 24.04.3, Intel N5095 with four logical cores, 19 GiB RAM (18 GiB available at inspection), PostgreSQL 16, one ~1.8 TiB primary filesystem and a second ~1.8 TiB mount. The retired website process is stopped. Another website and worker remain online and must not be disturbed. CPU and disk I/O may be limiting even when RAM looks plentiful.

The server's PostgreSQL service listens on all IPv4 and IPv6 interfaces. A broad UFW PostgreSQL allow rule was removed, but a historical client allow rule remains and may no longer match the developer workstation. PostgreSQL `ssl=on` alone does not force TLS for the currently observed `host` entries. The development workstation has a working localhost forwarded TCP port through SSH; a database authentication/authorization test has **not** yet passed. The firewall change is not proof of router-level public inaccessibility.

### Proposed boundaries and acceptance conditions

1. Preserve the existing website's code, databases, worker and PM2 saved state. Require verified backups and a rollback path before touching any shared service.
2. Use a separately owned unprivileged Pulse Metrics runtime with per-process resource limits and private directories. Avoid unreviewed PM2 root/shared application credentials; test deliberate CPU/memory pressure and service restart behavior.
3. Prefer a private PostgreSQL Unix-domain socket for an application on the same host, with independently proven OS identity and database authentication, or `verify-full` TLS with separately pinned CA/hostname for remotely networked database access. Never mistake an SSH TCP-listener check for PostgreSQL authentication.
4. Review `listen_addresses`, `pg_hba.conf`, IPv4/IPv6 UFW, router port forwarding, Nginx and cloud tunnel configuration. The stale remote database allow rule should be removed only after dependency and recovery-access review; no unrestricted public PostgreSQL port.
5. Create a separate `pulse_metrics` database, migration and runtime identities and independently restricted future maintenance identity **only through a separately authorized change**. FORCE RLS, pooled tenant context, grant-denial, credential and backup/restore tests must pass against actual server configuration. No existing Legendary Collectibles database account is reused.
6. Establish encrypted offsite backups, restore to an isolated instance, retention/deletion policy and independent audit custody controlled outside this server's administrator. A second local disk or local signing key is NOT independent custody.
7. Validate UPS/power behavior, ISP terms, public reachability, DNS/TLS, abuse prevention, intrusion detection, update windows, load test and credible RTO/RPO. The single-site pilot offers no high availability.
8. Preserve current `NO_GO` until every required release gate has independently reviewed evidence and explicit change authorization. Tests and Git commits cannot approve a live service.

## Cloud fallback comparisons (historical published partial costs)

- DigitalOcean 2 vCPU / 4 GiB basic VM ($24) plus 1 GiB single-node managed PostgreSQL ($15): **$39/month illustrative base**, no HA; CA/hostname-verified database TLS, private endpoint, FORCE RLS permissions and restore require actual testing.
- Render 2 GiB web ($25) and 1 GiB PostgreSQL ($19): **$44/month illustrative base**. Documented internal database SSL behavior does not satisfy proposed `verify-full` requirement without separate redesign/approval.
- DigitalOcean VM ($24) plus published two-node managed PostgreSQL HA starting subtotal ($60): **$84/month illustrative base**, still incomplete and still requires tested failover.

These figures are snapshots from 2026-11-14, not current guaranteed quotes, not pricing for the owner-operated server, and exclude custody, backup, traffic, monitoring, taxes, other environments and labor. Self-host cost is **unknown, not zero**.

## Separate independent custody

AWS S3 Object Lock in a separately administered security account is a technology candidate, not approved or provisioned. Independent retention, writer-only permissions, trusted key distribution and a real deletion/rollback drill are required. The Ed25519 keys in 5H/5I are synthetic; a cloud KMS signing algorithm cannot be assumed equivalent.

## Decision authority and next step

**No hosting platform is accepted.** The reviewed preference is to evaluate existing hardware first, retaining cloud as a migration/failover option. A later approved ADR revision must include measured benchmark and recovery evidence, independent audit/storage controls, operator IAM and explicitly authorized costs. Deploying Pulse Metrics, changing ports, deleting shared services or granting runtime permissions is outside D15C-5K.

Preserve the 16 unverified release gates and resume product integration work in parallel with careful infrastructure planning.

### Official provider reference pages for historical comparison

- https://www.digitalocean.com/pricing/droplets
- https://docs.digitalocean.com/products/databases/postgresql/details/pricing/
- https://docs.digitalocean.com/products/databases/postgresql/how-to/connect/
- https://docs.digitalocean.com/products/databases/postgresql/how-to/modify-user-privileges/
- https://render.com/pricing
- https://render.com/docs/postgresql-creating-connecting
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html
