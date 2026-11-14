# Pulse Metrics — D15C-5N Isolated Authenticated History Preview

**Date:** 2026-11-14

**Status:** Development candidate; localhost only; NO production approval.

**Baseline:** D15C-5M GitHub commit `159f3f9b044645c77c2e6781a6b2e11b8f640a7c` on `feat/identity-organization-onboarding`.

**PUBLIC LAUNCH: NO_GO**

## Purpose

D15C-5L created the tenant-checked history contract and handler. D15C-5M tested the real PostgreSQL history service and its Express handler with a synthetic token verifier, on a fully disposable cluster. D15C-5N assembles a separate local, read-only API preview using the real WorkOS verification configuration and the existing history handler. It does not enable the normal Pulse Metrics monitoring API in `server.ts`.

The preview has exactly one authenticated history endpoint:

`GET /api/organizations/:organizationId/agents/:agentId/history?range=1h`

Supported ranges: `15m`, `1h`, `24h`, `7d`. The existing history service verifies membership and agent ownership inside transaction-scoped PostgreSQL RLS and returns genuine persisted values. No raw metric JSON, SSH or command endpoint, login bypass, WebSocket, write operation, simulated host, public dashboard, or multi-tenant host list is added.

## New files (complete, additive)

1. `README-D15C-5N.md` — this document.
2. `src/server/monitoring/history-preview-policy.ts` — pure, strict localhost startup policy.
3. `src/server/monitoring/history-preview-policy.test.ts` — negative activation tests.
4. `src/server/monitoring/history-preview-app.ts` — real WorkOS middleware + existing history route + 503 catch-all.
5. `src/server/monitoring/history-preview-app.test.ts` — local HTTP identity/denial/shape tests using a synthetic verifier.
6. `scripts/monitoring-history/start-local-preview.ts` — opt-in standalone CLI, not imported by `server.ts`.
7. `scripts/monitoring-history/verify-5n-candidate.mjs` — immutable review hashes of the new sources; refuses a mounted main-server history API.
8. `scripts/test-monitoring-history-preview.sh` — offline test entrypoint.

## Development-only safety boundaries

- The preview CLI refuses unless `NODE_ENV=development` and `PULSE_HISTORY_PREVIEW=read-only` are both explicitly configured.
- The database URL must point to `pulse_metrics` using `pulse_metrics_app` on `localhost` or `127.0.0.1`, exactly port `5432`, with no query-string overrides. This explicitly rejects the development SSH tunnel on port `15432` and remote hosts.
- The listener always binds `127.0.0.1`; port defaults to `3077`, with a narrowly validated optional `PULSE_HISTORY_PREVIEW_PORT`.
- The CLI uses the configured WorkOS JWT verifier. Test doubles exist only in the test file; no fake authorization or JWT bypass is accepted by the CLI.
- The HTTP app offers only one GET history route. Other `/api` requests return 503 after authentication. WebSocket upgrade requests are rejected.
- Responses are no-store and no-sniff; connection strings and JWTs must not be logged.
- `server.ts`, the legacy hold, the 5L/5M verifier files, migrations, PostgreSQL, Cloudflare, PM2, and the `work` server are not changed.
- This preview is not approved for reverse-proxy exposure. Binding localhost is not by itself protection against a misconfigured reverse proxy or local attacker.
- The existing 5M disposable real-PostgreSQL test remains the database evidence. These 5N tests verify the new composition and activation controls; they do **not** prove a live WorkOS tenant login or production endpoint readiness.

## Run on adap (not on work)

After downloading the package into `~/Downloads`, from your development working tree:

```bash
cd ~/Projects/pulse-metrics

git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c5n-local-history-preview.zip
unzip -o ~/Downloads/pulse-metrics-d15c5n-local-history-preview.zip

bash scripts/test-monitoring-history-preview.sh
npm run lint && npm test && npm run build && git diff --check && git status -sb
```

The verification runner is intentionally non-deploying and does not connect to PostgreSQL. It runs the new tests and the existing 5L/5M source locks. The full test suite should discover the two new `src/**/*.test.ts` files.

### Optional manual preview (only after review)

The preview does not need to run to pass 5N. If a future locally authorized test requires it, confirm `.env` points to a local development database (never production or a tunnel) and WorkOS is configured, then on `adap` only:

```bash
cd ~/Projects/pulse-metrics
NODE_ENV=development PULSE_HISTORY_PREVIEW=read-only \
  npx tsx scripts/monitoring-history/start-local-preview.ts
```

Stop with Ctrl+C. By default the preview listens only on `127.0.0.1:3077`. Requests require a real, verified WorkOS access token and an authorized existing organization/agent in the local database. Do not paste a bearer token into chat, shell history, logs, or command-line arguments. Do not reverse proxy this preview.

No dashboard is yet connected; the main app continues to show its honest no-data holding screen.

## Acceptance criteria and next work

The 5N tests must demonstrate: explicit local opt-in only; rejection of production mode and wrong database destinations; missing or invalid token denied before loading history; verified identity carried through the existing route; forbidden selectors rejected; foreign tenant and unknown agent safely denied; no fabricated data or logs; other endpoints remain held; main server unchanged.

If 5N passes, the next milestone is a separately reviewed **same-origin, production-ingress-aware authenticated route activation design** followed by the React historical UI that displays actual values and empty/stale/unavailable states. Before public exposure, independently verify live WorkOS JWTs, reverse proxy provenance, host admission, rate limits and database RLS under realistic operation. Public release remains blocked by the existing production gates.

**PUBLIC LAUNCH: NO_GO**
