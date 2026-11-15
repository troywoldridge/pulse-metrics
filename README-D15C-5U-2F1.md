# Pulse Metrics D15C-5U-2F1 — Guarded Local-Development PostgreSQL Controls

**Status:** candidate; not installed or run on the user's development machine. Public launch NO-GO.

## Verified prerequisite

D15C-5U-2E2A passed: byte-verified stopped PostgreSQL copy, two isolated restore starts/security audits, clean removal. Original separate development cluster remained stopped. This is **not** a retained backup strategy or PITR proof.

## Purpose

Provide separate, quarantine-preserving controls for the **exact existing** 16.x PostgreSQL cluster in `/var/lib/postgresql/pulse-metrics-dev-5u2` on private Unix socket port `55433`. The old `manage-persistent-development.sh` requires a `.pulse-5u2-ready` marker that this cluster does not have and must not acquire prematurely. This new script **never** creates that marker.

This is an operator tool, not a monitoring service. Running PostgreSQL is not the same as authorizing an agent, starting an ingress HTTP handler, or releasing a SaaS product. It rejects production settings, arbitrary paths, inherited DB URLs, linked private directories, missing historical source fingerprint, nonlocal connections, missing exact migration receipts, unexpected customer data, unsafe RLS, and credential reads by the ordinary app role. The original database catalog fingerprint remains guarded via the pinned offline inspector.

## Modes

- `--plan`: local-only description; no database start or changes.
- `--status`: live read-only audit if running; otherwise full offline inspector.
- `--start`: requires `PULSE_APPROVE_5U2F_LOCAL_START=EXACT_SOCKET_ONLY`; starts **only** the pinned PostgreSQL cluster, audits receipt/security/zero records and leaves it running locally if all pass. On failure it attempts mandatory shutdown.
- `--audit`: read-only database security audit of the running target.
- `--stop`: shuts down only pinned local cluster and checks offline/original database invariants. Intended also for immediate shutdown if a live audit would fail.

No migrations, fixtures, schema updates, agent provisioning, public HTTP routes, ready marker or irreversible data changes occur. Normal PostgreSQL operational files change on start/stop.

## Scope of checks and limitations

Checks migration receipt counts, app/migrator privileges, private schema table forced RLS, SECURITY DEFINER ingestion function metadata, zero operational rows and a real restricted-role SELECT denial. The privileged SQL audit is inline and read-only; it does not execute a mutable, unpinned SQL file as PostgreSQL superuser. Does **not** prove real-world tenant isolation against nonempty customer data; that must be tested separately in disposable environments and staged operational pilots. Also does not cover off-machine retained backups, production compliance, alerting, retention, key management, or availability.

Do **not** run the old `manage-persistent-development.sh` or any old `--apply`/`--resume` script. Do not connect production or Internet-facing systems to port `55433`. After the local operator audit, stop PostgreSQL unless a separately reviewed local telemetry pilot requires it.

On error, capture the output before retrying. Do not delete, chmod or edit PostgreSQL directories, or create a ready marker by hand.
