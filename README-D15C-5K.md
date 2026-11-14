# Pulse Metrics — D15C-5K Hosting Shortlist and Self-Hosted Pilot Review

**Status:** REVIEW ONLY — updated 2026-11-14 after operator server assessment.
**Commercial public launch:** NO_GO.
**Dependency:** Committed D15C-5J ADR-010 and 16 unverified release gates.

## Why the shortlist changed

The original 5K proposal recommended DigitalOcean before the owner supplied read-only diagnostics of an existing Ubuntu server. That new evidence changes the first **conditional private-pilot candidate** to existing owner-operated hardware. No provider is accepted, no new Pulse Metrics runtime has been deployed, and no customer traffic is authorized. The machine is still shared with a separately operated website and worker.

### Observed, not independently certified

- Ubuntu 24.04.3 LTS; Intel Celeron N5095, 4 logical cores; about 19 GiB RAM, about 18 GiB available at inspection.
- Approximately 1.8 TiB primary filesystem and 1.8 TiB additional mounted filesystem. Two disks on the same site are **not offsite backup or independent custody**.
- Existing PostgreSQL 16 active, TLS enabled but `host` rules do not require TLS; listener still binds IPv4/IPv6 all interfaces. Publicly broad UFW allowance for PostgreSQL was removed, while an obsolete-looking permitted source remains. Future restrictive listener policy and authenticated LAN access require separate review.
- The obsolete web application was stopped; the good website and its valuation worker remain online and must be preserved. PM2 startup persistence of the stopped app was not verified.
- An SSH forwarded **TCP endpoint** on the development workstation accepted a connection. PostgreSQL authentication through the tunnel, client role permissions, and full TLS/Unix-domain-socket requirements have **not** been tested.
- Single site, single CPU/storage failure domain, residential/business power and fiber reliability unknown; real outage, RTO/RPO, CPU and ingestion capacity tests pending.

### Cost truth

**Existing equipment is not free hosting.** Self-host monthly operating spend is currently **unknown** (electricity, UPS/battery, ISP terms, offsite encrypted backups, independent security custody, maintenance, hardware replacements, alert services and recovery). The JSON stores `null`, never $0, for the self-host price. Historical published alternatives remain comparison-only: DigitalOcean $39/month (non-HA), Render $44/month (internal TLS verification mismatch), DO with HA database $84/month; all partial subtotals, no provider orders or customer deployment.

## Ten complete updated files

1. `README-D15C-5K.md` — updated complete guide.
2. `docs/architecture/ADR-011-PLATFORM-SELECTION-SHORTLIST.md` — revised, PROPOSED ADR.
3. `docs/operations/D15C-5K-BUDGET-AND-ROLLBACK-PLANNING.md` — self-host cost/continuity duties.
4. `docs/security/D15C-5K-PROVIDER-DUE-DILIGENCE.md` — private-host gates and cloud fallback.
5. `docs/security/D15C-5K-PLATFORM-SHORTLIST.json` — machine-readable immutable-for-review candidate list.
6. `scripts/telemetry-maintenance/platform-shortlist-contract.mjs` — strict offline policy.
7. `scripts/telemetry-maintenance/platform-shortlist-contract.test.mjs` — 38 isolated tests.
8. `scripts/telemetry-maintenance/platform-shortlist-rehearsal.mjs` — checks the unchanged 5J launch invariants.
9. `scripts/telemetry-maintenance/verify-platform-shortlist-candidate.mjs` — updated source SHA-256 pins.
10. `scripts/test-maintenance-platform-shortlist.sh` — offline-only acceptance runner.

All ten files are **full replacements** for the originally uncommitted 5K package. No existing 5J files, database permissions, migrations, application processes, cloud accounts, secrets, network routes, SSH connections or schedulers are modified by this ZIP.

## Install on the DEVELOPMENT machine, not the hosting server

First confirm the 5K files are not yet committed or modified locally. Download the revised ZIP, review its 10 paths, then overwrite the prior 5K files end-to-end:

```bash
cd ~/Projects/pulse-metrics
unzip -l ~/Downloads/pulse-metrics-d15c5k-self-hosted-pilot-review.zip
unzip -o ~/Downloads/pulse-metrics-d15c5k-self-hosted-pilot-review.zip
bash scripts/test-maintenance-platform-shortlist.sh
npm run lint && npm test && npm run build && git diff --check
```

Run a staged whitespace check before any commit: `git diff --cached --check`. Do not accidentally stage older troubleshooting READMEs.

## Acceptance meaning

- 38 contract tests and the read-only acceptance runner should pass offline.
- Rejected inputs cannot falsely claim a zero-dollar server, independent custody, successful restore, HA, PostgreSQL authentication, deployment or a verified launch gate.
- The 16 D15C-5J launch gates remain externally unverified.
- Public customer traffic, dispatch, remote shell, auto-replay, production roles and scheduler activation are all **unauthorized**.

## Next engineering focus

Do not spend multiple milestones tuning idle hosting before completing product foundations. After committing the revised 5K package, resume authenticated ingestion / historical data / dashboard integration work on the development machine. Keep the operator-owned server a **separate, explicitly authorized infrastructure workstream**: isolate a service identity, review LAN/IPv6 ports, decide PostgreSQL local socket versus certificate-verified remote path, restore an encrypted offsite backup and assess capacity. None of that work is authorized by this review package.

**Release decision: NO_GO.**
