# D15C-5K — Self-Hosted Pilot Budget, Rollback and Recovery Plan

**Review only. Date: 2026-11-14. Public launch: NO_GO.**

## Budget estimates must distinguish unknown cost from zero

| Scenario | Monthly compute + database subtotal | Operational caveat |
|---|---:|---|
| Existing owner-operated server, private noncustomer pilot | **UNKNOWN** | Existing sunk hardware does not mean free electricity, UPS, offsite custody, ISP, labor, backups or replacement |
| DigitalOcean basic 4 GiB VM plus single-node managed PostgreSQL | **$39** | Published example only; not HA and excludes recovery, custody, tax and extra environments |
| Render 2 GiB web plus 1 GiB managed PostgreSQL | **$44** | Published example only; current internal Postgres TLS does not meet proposed 5J hostname-verification control |
| DigitalOcean VM plus managed PostgreSQL HA entry | **$84** | Published component subtotal; not an all-in HA application design |

All prices are 2026-11-14 snapshot examples; not new quotes or purchases. The owner should measure wall-power draw and energy price, UPS/battery investment, fiber service terms, DNS, monitoring, encrypted offsite backup retention, external audit storage, key management, spare disks, maintenance time and restore costs. **Never encode `$0/month` for the existing server.**

## Preserve the existing business

- Keep the good website and its valuation worker online; do not stop the PostgreSQL system service, Nginx or the cloud tunnel as a side effect.
- An obsolete website's PM2 process is currently stopped, but it may be restored by saved startup state. Check and explicitly approve PM2 persistence changes before touching them.
- No delete, disable, apt install, firewall update, DB role grant, port binding, service deployment, or user creation is part of the D15C-5K review package.
- Back up and test restoration of any business data before adding an application to the shared machine.

## Outage/failure readiness blockers

1. A second local disk is not independent of fire, theft, ransomware, physical loss, administrator compromise or shared power failure. Backups must be encrypted and tested outside the host.
2. Produce real restoration evidence using a separate isolated PostgreSQL target. Demonstrate authorization and FORCE RLS still work after restoration.
3. Determine achievable recovery point/time and communicate the single-site availability constraint honestly. Provide measured UPS and external internet outage behavior.
4. Validate application process restart, resource ceilings and CPU/IO concurrency with the existing good website and worker; N5095 is a modest CPU.
5. Confirm remote PostgreSQL port scope and authorization; SSH local forwarding is an admin convenience, not an agent telemetry transport.
6. External audit custody and live operators must have independently controlled credentials; a filesystem on the same server cannot certify its own history.
7. Conduct a privacy/security review for telemetry retention, data exports and deletion before processing customer data.

**Current decision: conditional private-pilot option; no service approved.**
