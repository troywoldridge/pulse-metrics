# Pulse Metrics — D15C-3B review-only telemetry network quota

This bundle contains **new files only**:

- `scripts/telemetry-quota/migrations/0001_telemetry_network_quota.sql`
- `scripts/telemetry-quota/migrations/manifest.json`
- `scripts/telemetry-quota/verify-candidate.mjs`

**Do not execute the SQL.** It is an uninstalled candidate for a later marker-verified disposable PostgreSQL rehearsal. It intentionally rejects ordinary local development and production databases.

From the Pulse Metrics repository root after extracting the bundle, run:

```bash
node scripts/telemetry-quota/verify-candidate.mjs
sha256sum scripts/telemetry-quota/migrations/0001_telemetry_network_quota.sql
npm run lint
npm test
npm run build
git status --short
```

Expected SQL SHA-256:

`4cce6ab1a31d4f0f323e6c5ad380b46fc21f1611198b44cf914b74118e29afe8`

The database function `pulse_telemetry_quota.consume_network_quota(text)` implements a **provisional** ceiling of 1,200 calls/60 seconds per HMAC digest, with atomic UPSERT counters and opaque identifiers. This must be capacity-tested and checked for large NAT/shared-source networks before production use. This release does **not** include authenticated agent quotas or bucket cleanup. The application adapter remains unmounted. Public launch stays **NO_GO**.
