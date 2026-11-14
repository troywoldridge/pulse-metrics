# Pulse Metrics — D15C-5O Authenticated History Dashboard Foundation

**Reviewed against:** GitHub branch `feat/identity-organization-onboarding`, commit `6949bf535995a266ed393fe4c27af1b433bfb35a` (D15C-5N).

**Status:** Development candidate. React components are deliberately **unmounted**. Public launch: **NO_GO**.

## Goal

Create the browser-side building blocks for displaying *real* authenticated, tenant-scoped PostgreSQL history without modifying the active Express server, opening the 5N preview to the internet, granting new permissions, changing the current onboarding UI or fabricating any measurements.

The existing 5L/5M/5N code already provides the history contract, restricted PostgreSQL service, disposable-database isolation evidence, and separately guarded localhost API preview. 5O adds the React history interface and strict same-origin data client. It DOES NOT enable the API on port 3000 or connect the React dashboard to the 5N preview on port 3077. Those changes require a separate reviewed same-origin integration milestone.

## Ten complete new files

1. `README-D15C-5O.md` — this review, acceptance and limitations.
2. `src/monitoring/history-client.ts` — same-origin, explicit WorkOS bearer history client with bounded response decoding, exact ownership/shape checks, and no leaked errors.
3. `src/monitoring/history-client.test.ts` — token, tenant selector, redirect, malformed, oversized, and failure tests.
4. `src/monitoring/history-state.ts` — honest ready/stale/empty/unmeasured/error derivation.
5. `src/monitoring/history-state.test.ts` — data freshness and null semantics tests.
6. `src/components/RealHistoryPanel.tsx` — read-only history panel with five metric cards, interval controls, utilization traces and missing-data gaps.
7. `src/components/RealHistoryPanel.test.tsx` — server-rendered UI checks for unavailable, empty, stale, null, zero, truncation, XSS escaping and gaps.
8. `src/components/AuthenticatedHistoryDashboard.tsx` — **unmounted, disabled by default**, WorkOS-aware container that aborts superseded requests and keys results to identity, tenant, agent and interval.
9. `scripts/test-monitoring-dashboard-foundation.sh` — safe offline source checks and new test runner.
10. `scripts/monitoring-history/verify-5o-candidate.mjs` — independently pinned source SHA-256, trailing whitespace and unmounted-server hold checks.

All ten are new. This package does NOT overwrite `server.ts`, `src/main.tsx`, `src/components/AuthenticatedBoundary.tsx`, the 5L/5M/5N sources, existing hash verifiers, SQL migrations, database roles or user data.

## Security and truthfulness

- All API reads use a relative path under `/api/organizations/:organizationId/agents/:agentId/history?range=<fixed>`. The browser does not control the user/role in the request and cannot set arbitrary dates.
- An access token must be obtained from WorkOS `getAccessToken()` at request time. Tokens travel only in the `Authorization` header. The client does not persist tokens in URLs, local storage, logs or query strings.
- Requests are GET, `no-store`, omit browser cookies, and reject redirects. API responses are streamed with a size cap and must have JSON media type.
- Any mismatched organization, agent, interval, malformed JSON/ISO date, invalid number, unsorted points, unexpected property or excessive history is rejected. Network/WorkOS exceptions are converted to sanitized states.
- The latest stored sample, never an older available sample, determines what each current card displays. A database `0` is a genuine `0`; a database `null` displays **Not measured**. Cumulative network counters are not invented as rates.
- Readings older than two minutes are explicitly labeled **stale**; absence of history is not treated as healthy or offline. A recent sample containing entirely missing metrics is marked **unmeasured**.
- CPU/memory/disk trends never connect across missing values. No process lists, shell execution, SSH, WebSockets, customer host discovery or fake health grades.
- The React container is disabled by default and is NOT mounted by `src/main.tsx`. Even if an integrator opts in later, PostgreSQL still independently authorizes the verified user/organization/agent.

## Run only on the `adap` development workstation

After downloading the ZIP to `~/Downloads`:

```bash
cd ~/Projects/pulse-metrics
unzip -l ~/Downloads/pulse-metrics-d15c5o-dashboard-foundation.zip
unzip -o ~/Downloads/pulse-metrics-d15c5o-dashboard-foundation.zip

bash scripts/test-monitoring-dashboard-foundation.sh
npm run lint && npm test && npm run build && git diff --check && git status -sb
```

The offline 5O script checks source locks and executes the new `tsx` unit and React SSR tests. It does **not** touch PostgreSQL or make remote requests. The full `npm test` discovers the new `src/**/*.test.ts[x]` files. Confirm the results before staging/committing.

## Limitations and next gate

The 5O tests exercise the exact browser client contract and rendered UI states. They do not validate live WorkOS login, end-to-end API streaming against the normal app, CORS, agent listing or a production reverse proxy. They also do not prove the behavior of an agent sending real samples through HTTPS. The 5N localhost preview remains separately opt-in; this component is not wired to it yet.

Next review: activate a safely bounded **same-origin development-only history view** after authenticated organization and agent selection, validate real WorkOS sessions and restricted PostgreSQL access, then review the production ingress boundary. Any such mount is a new milestone and must explicitly reconcile the existing 5L/5M/5N source locks rather than silently weakening them.

**PUBLIC LAUNCH: NO_GO**
