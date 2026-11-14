# Pulse Metrics — D15C-5L Tenant-Authorized Real Telemetry History Candidate

**Date:** 2026-11-14
**Status:** Offline development candidate; NOT mounted or production-approved
**Baseline:** `feat/identity-organization-onboarding` at D15C-5K commit `8d81b2d054cc4e9c0adb6115f94efb42354c7030`
**Commercial launch:** `NO_GO`

## What we are delivering

This milestone starts turning genuine persisted telemetry into a customer-readable history API **without loosening the existing monitoring hold**. The current `server.ts` deliberately returns 503 for monitoring endpoints; this package does not change that. There are no credentials, fabricated measurements, shell execution, WebSockets, hosting changes, PostgreSQL migration, firewall changes, or running application changes.

New code paths:

- `src/server/monitoring/history-contract.ts`: strict organization/agent UUIDs, fixed windows (`15m`, `1h`, `24h`, `7d`), server-determined time bounds, maximum 500 points, and values taken *only from persisted columns*. The result carries `receivedAt` and `recordedAt`; unavailable numeric values stay `null`. Never infer network bandwidth from cumulative counters.
- `src/server/monitoring/history-service.ts`: resolves server-verified WorkOS identity to local user UUID, reuses existing `withOrganizationContext` transaction and database RLS, checks the selected tenant-owned agent, then reads only that organization's and that agent's rows through an explicitly bounded query. Latest 501 rows are requested to signal truncation accurately. Raw telemetry JSON, credentials, host secrets, and global user data are never returned.
- `src/server/monitoring/history-route.ts`: a fail-closed, **unmounted** Express handler candidate. A separately verified `requireWorkOSUser` middleware must precede it if it is reviewed for mounting later. The handler also checks the established identity, rejects query-based identity/role/time overrides, validates the loader response, and emits generic error responses.
- `src/server/monitoring/history-contract.test.ts`: tests the pure history contract.
- `src/server/monitoring/history-route.test.ts`: isolated localhost Express tests with a synthetic WorkOS verifier and injected history reader. These tests make no database calls.
- `scripts/telemetry-maintenance/verify-history-contract-candidate.mjs`: SHA-256 source review lock plus guard ensuring the monitoring endpoints remain unmounted.
- `scripts/test-monitoring-history-contract.sh`: offline acceptance test runner; rejects production environment and known live infrastructure connection variables.

## Critical truth about readiness

1. **This package adds real-history read implementation, not a live customer API.** `server.ts` is untouched. Do not manually register the route yet.
2. The older `HistoricalView.tsx` still expects a legacy `/api/history?hostId=...` shape, including fields for download/upload speeds and disk I/O that do not exist as reliably measured values in current telemetry. Do not connect it blindly or render missing values as zero.
3. A real database integration test is still required, using the restricted application role against a disposable cluster. Required negative cases: no membership, different organization, agent belonging to a different organization, unscoped transaction, revoked membership, pool reuse and malformed time selections.
4. The application must prove that the full authenticated middleware chain and authorized database adapter work together before any route mount. Genuine end-to-end agent delivery into PostgreSQL must be verified separately.
5. The network speed summary columns are currently `NULL` in the ingestion normalizer; this API preserves those `NULL` values. Any future bandwidth calculation requires a reviewed counter-delta design.
6. The maximum is 500 recent raw rows, **not downsampled history**. `truncated: true` means the requested window contained more than 500 samples. A future pagination/aggregation policy needs separate review.
7. No claim of public security readiness follows from passing offline tests. Release register and production security gates remain blocked.

## Install only on development PC (`adap`)

Confirm the Git branch and current worktree first. The archive contains **8 new files** and does **not** overwrite existing project files. Unzip from Downloads into the root of the repository:

```bash
cd ~/Projects/pulse-metrics
git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5l-tenant-history-candidate.zip
unzip -o ~/Downloads/pulse-metrics-d15c5l-tenant-history-candidate.zip
```

Then run:

```bash
cd ~/Projects/pulse-metrics
bash scripts/test-monitoring-history-contract.sh
npm run lint
npm test
npm run build
git diff --check
git status -sb
```

The two new test files become part of the existing `npm test` discovery. Do not commit unless these tests and the full application tests pass. Do not stage unrelated old troubleshooting READMEs.

## Future engineering exit criteria

The next integration milestone must add disposable real-PostgreSQL cross-tenant tests, schema/grant verification, and independently reviewed authorized route mounting. Only then should the React dashboard consume the new *real* response contract, including honest unavailable/stale states.

**PUBLIC LAUNCH: NO_GO**
