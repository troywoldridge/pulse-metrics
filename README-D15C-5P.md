# Pulse Metrics — D15C-5P Same-Origin Local History Dashboard

**Reviewed baseline:** `feat/identity-organization-onboarding` at `ddb3e7de2e75163cc0b6b2ef0677ef2a2ee6ba06` (D15C-5O).

**Status:** Local-development candidate. **PUBLIC LAUNCH: NO_GO.**

## Purpose

D15C-5L implemented a tenant-scoped PostgreSQL history reader; 5M verified real database isolation on a disposable cluster; 5N provided a separate opt-in localhost API preview; 5O created a real-history React panel and safe data client. D15C-5P connects the 5O panel to the API on a **single localhost origin**, without mounting any monitoring endpoint into `server.ts` or removing the 5L/5M/5N/5O hash guards.

**This is a development-only read-only preview, not public launch approval.** The normal application continues to show secure onboarding and its 503 monitoring hold. No new PostgreSQL schema, privileged SQL, deployment, SSH, customer telemetry, fake readings, local fixtures or production-network listener is created.

## What is included

- `src/server/monitoring/same-origin-preview-app.ts`: independent Express composition with verified WorkOS bearer for exactly `GET /api/organizations` and `GET /api/organizations/:organizationId/agents/:agentId/history`. All other `/api` paths remain denied.
- `src/server/monitoring/same-origin-preview-app.test.ts`: negative and positive HTTP composition tests using injected **test-only** token/loader values.
- `src/monitoring/preview-organization-client.ts`: strict same-origin WorkOS organization-list reader; caps response size, rejects unexpected metadata, never trusts browser-supplied roles as authority.
- `src/monitoring/preview-organization-client.test.ts`: organization parsing, selection, no-network-invalid-token, header and failure tests.
- `src/components/LocalHistoryPreview.tsx`: WorkOS sign-in, verified organization selector, explicit authorized agent UUID, and the existing 5O history panel. No hard-coded org/agent/host or sample data.
- `src/monitoring/history-preview-main.tsx`: **standalone preview entry point**, separate from `src/main.tsx`, using the exact localhost callback origin.
- `scripts/monitoring-history/start-same-origin-preview.ts`: locally guarded Vite middleware + API server sharing `127.0.0.1:3077` by default; WebSockets denied.
- `scripts/test-monitoring-same-origin-preview.sh`: read-only offline regression checks.
- `scripts/monitoring-history/verify-5p-candidate.mjs`: pinned source SHA-256, forbidden-mount checks and legacy hold verification.
- `README-D15C-5P.md`: this guide.

**No existing project files are changed.** Previous pinned source verification remains intact. All new code is full-file, additive implementation.

## Architecture and boundaries

Browser `http://127.0.0.1:3077/history-preview`
→ WorkOS AuthKit sign-in with the callback registered for that exact origin
→ `GET /api/organizations` (same origin, JWT verified by WorkOS server middleware)
→ select a server-authorized organization and type an existing authorized agent UUID
→ `GET /api/organizations/:organizationId/agents/:agentId/history?range=1h` (same origin, JWT verified again)
→ organization membership, agent ownership and PostgreSQL RLS are verified by the existing restricted-role history service
→ 5O client re-validates response ownership and renders genuine values or an honest empty/stale/unavailable state.

The organization dropdown only helps the UI. Authorization is always rechecked on the server. Agent discovery is deliberately **not** introduced in 5P; this preview asks for a UUID already known through authorized development procedures. Do **not** query or share other customers' agent IDs.

The page has no fake metrics, simulated health status, SSH, WebSockets, machine ingress, remote user probes, admin actions, device command execution or production monitoring mount. The Vite frontend is deliberately served by the same local Express origin, not through a cross-origin proxy or redirect. Only the expected history and organization routes are read-enabled in this separate process.

`127.0.0.1` binding is not a production security boundary: do not reverse-proxy, tunnel, expose or deploy this preview. The local port must not be used by the 5N API-only preview simultaneously. Never paste WorkOS tokens, database passwords or enrollment credentials into terminal commands or chat.

## Install and validate on `adap`

Download the ZIP to `~/Downloads`, then run in the Git repository:

```bash
cd ~/Projects/pulse-metrics
unzip -l ~/Downloads/pulse-metrics-d15c5p-same-origin-dashboard.zip
unzip -o ~/Downloads/pulse-metrics-d15c5p-same-origin-dashboard.zip

bash scripts/test-monitoring-same-origin-preview.sh
npm run lint && npm test && npm run build && git diff --check && git status -sb
```

The offline tests use a synthetic WorkOS verifier and mock history rows exclusively in the test runner. **They do not prove live WorkOS login or real data in the browser.** Those are separate operator checks.

## Optional local manual smoke test AFTER tests pass

1. Ensure the local, non-production `.env` config uses `pulse_metrics_app` at `127.0.0.1:5432/pulse_metrics` or `localhost:5432/pulse_metrics` with no URL query parameters. Do not point at `work`, a remote DB, SSH tunnel or any production system.
2. WorkOS must allow the **exact** redirect URI `http://127.0.0.1:3077/history-preview` (or your independently approved custom preview port). Verify it in the WorkOS development application's redirect settings. Keep server `WORKOS_CLIENT_ID`, browser `VITE_WORKOS_CLIENT_ID`, issuer and audience configured consistently. **Never bypass WorkOS validation if this callback is unavailable.**
3. Ensure neither the 5N API-only preview nor another process occupies port 3077. Do not stop unrelated services automatically.
4. Start in a foreground terminal on `adap` only:

```bash
cd ~/Projects/pulse-metrics
NODE_ENV=development PULSE_HISTORY_PREVIEW=read-only PULSE_SAME_ORIGIN_PREVIEW=enabled \
  npx tsx scripts/monitoring-history/start-same-origin-preview.ts
```

Open `http://127.0.0.1:3077/history-preview` **on the same PC**. WorkOS will require a real sign-in; the organization list should be limited to your own memberships. If an enrolled agent with history is available in your local development database, enter its already-authorized UUID and select **Load history**. Otherwise, expect an honest `agent_not_found` or empty-history message; **do not insert fictional data into the working database** to force a chart. To stop, press Ctrl+C.

The normal app on port 3000 is untouched. An API-only request to the separate preview without a valid bearer receives 401; other monitoring paths are withheld. A registered WorkOS callback and successful sign-in do not by themselves prove the agent has ever delivered measurements.

## Review criteria before considering D15C-5P complete

- Source SHA verification and prior 5L/5M/5N/5O locks pass; `server.ts`, `src/main.tsx`, identity/onboarding, history services and migrations are unchanged.
- The new HTTP tests prove GET-only, JWT-first composition and no unauthorized API route; the organization client rejects forged metadata and unsafe responses.
- TypeScript and full project tests pass; production Vite build passes. Vite development preview itself is never bundled into the production entry.
- Optional real browser smoke test confirms WorkOS login and authorized history access **only if the local configuration and an enrolled agent are available**; no manufactured measurements.
- No public launch, production route mount, websocket, relay, database role grant, or provider deployment is authorized.

**PUBLIC LAUNCH: NO_GO.** Future work must include live WorkOS+DB verification, audited ingress/rate limiting and agent discovery before public activation. A passing 5P test does not satisfy release gates.
