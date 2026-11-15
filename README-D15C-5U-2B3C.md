# Pulse Metrics D15C-5U-2B3C — Quarantined Persistent Cluster SQL Inventory

**Status:** review-only inspection; not a recovery/migration release.
**Production launch:** NO-GO.

## Why this step is necessary

The persistent developer PostgreSQL cluster stopped after genuine Drizzle and six privileged migrations, enrollment and D15B ingestion. The next candidate (`scripts/telemetry-quota/migrations/0001_telemetry_network_quota.sql`) **refused intentionally** because it explicitly permits only a marker-verified **disposable** cluster on port 55432 under `/tmp/pulse-replay-…`. Its dependent agent-quota and credential-outcome migrations also explicitly prohibit normal development and production installations.

Do **not** edit those SQL sources to remove the guards, impersonate a disposable cluster, reuse `--resume`, install a fresh migration receipt manually, or enroll any machine in the incomplete persistent cluster.

## Inspections

Run from the repository root as the normal Linux user:

```bash
bash -n scripts/telemetry-dev/inspect-quarantined-persistent-sql.sh
env -u NODE_OPTIONS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-dev/inspect-quarantined-persistent-sql.sh
```

The script verifies the existing 5U-2B1 offline checker and the original database fingerprint, temporarily starts the exact retained Unix-socket-only PostgreSQL cluster, inspects catalog/receipt/count metadata in `BEGIN READ ONLY`, stops the cluster in an EXIT trap, and verifies the original catalog once more.

**There are no migration writes, permission changes, credentials, fixtures or API activations.** PostgreSQL start/stop writes ordinary operational files and logs.

## Decision after output

Treat the persistent cluster as **quarantined** even when the inspected partial state matches expectations. The next engineering task is a reviewed and tested *separate persistent-deployment migration line*, with versioning and no modifications to the immutable disposable-only SQL sources. Review the previous enrollment and D15B installation policy as well. Require dedicated local-only and adversarial RLS/quotas tests before promoting the cluster to development telemetry use.
