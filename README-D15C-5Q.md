# Pulse Metrics — D15C-5Q Tenant-Scoped Agent Picker (Candidate)

**Status:** Local-only review candidate. **PUBLIC LAUNCH: NO_GO.**

## Why

D15C-5P proved the browser could authenticate via WorkOS, list a locally provisioned organization, and reach the authorized historical API. But it required a human to enter an agent UUID. A commercial monitoring UI must let an authenticated customer choose an authorized server by its recognizable name. D15C-5Q adds an agent picker as a **separate**, optional local history preview, leaving the 5P code, its source hashes, the normal `server.ts`, the production entry point, database roles, and migrations untouched.

## What the new preview does

- Uses verified WorkOS bearer authentication on every request.
- `GET /api/organizations` lists only existing authorized organizations (unchanged behavior).
- `GET /api/organizations/:organizationId/agents` resolves the server-verified WorkOS user to a local database user UUID, then verifies organization membership inside a PostgreSQL transaction before installing tenant context. The restricted application role and forced RLS filter agent rows independently. The query also filters the chosen organization, excludes revoked agents, and limits its result to 50 (returns 503 when more, pending pagination).
- Returns only `id`, `displayName`, `hostname`, `platform`, `status`, and `lastSeenAt` for the 50-or-fewer authorized agents. No credentials, machine enrollment tokens, raw telemetry JSON, or other organization IDs are exposed.
- Browser validates a strict, size-bounded response; shows named server choices; passes only the chosen agent UUID internally to the **existing** history reader, which independently verifies membership and agent ownership again.
- If there are no eligible agents, the screen explicitly says that no monitoring agents are enrolled. **It does not create fake agents or pretend a real server is reporting.**
- All statuses are **recorded database states**, not a live health indicator. Historical charts remain read-only and honest about absent or stale data.

## Install and verify

Stop the D15C-5P preview on 3077 with Ctrl+C before starting D15C-5Q. Keep the ordinary onboarding app on 3000 if needed; **do not run both 5P and 5Q on 3077**. This package adds entirely new files; it does not replace pinned files.

Extract the ZIP at your repo root:

```bash
cd ~/Projects/pulse-metrics
unzip -l ~/Downloads/pulse-metrics-d15c5q-agent-picker-candidate.zip
unzip -o ~/Downloads/pulse-metrics-d15c5q-agent-picker-candidate.zip
bash scripts/test-monitoring-agent-picker-preview.sh
npm run lint && npm test && npm run build && git diff --check && git status -sb
```

Tests are offline (test-only verifiers and fixture lists, no real account secrets). Do **not** interpret a passing test as a real WorkOS + PostgreSQL cross-organization integration test; that still needs a separately controlled restricted-role test before production approval.

Only after all tests pass, run this **on `adap` itself**, in the foreground:

```bash
cd ~/Projects/pulse-metrics
NODE_ENV=development \
PULSE_HISTORY_PREVIEW=read-only \
PULSE_SAME_ORIGIN_PREVIEW=enabled \
PULSE_AGENT_PICKER_PREVIEW=enabled \
npx tsx scripts/monitoring-history/start-agent-picker-preview.ts
```

Open `http://127.0.0.1:3077/history-preview`, sign in with the existing WorkOS account, and select the organization. If an authorized agent exists, choose its friendly name and click **Load history**. If no agent exists, the empty-state message is correct: the next step is D13/D14 secure agent preauthorization and enrollment review, not guessing or inserting UUIDs or fictional telemetry.

The existing WorkOS callback and allowed web origin for 3077 remain unchanged. Local DB must remain `pulse_metrics` via the restricted `pulse_metrics_app` on `127.0.0.1:5432` or `localhost:5432` with no URL options. The launcher requires the same 5N and 5P flags **plus** `PULSE_AGENT_PICKER_PREVIEW=enabled`; it never listens outside `127.0.0.1`. No public ingress, nginx proxy, tunnel, work-server deployment, SSH, production monitoring, WebSocket upgrades or agent writes are permitted.

## Review boundary

D15C-5Q adds a GET-only agent-list read to its **separate preview process**. It does not authorize browser-selected roles, user IDs, machine credentials, or agent creation. Revoked agents are not selectable. The `server.ts` monitoring-hold path remains unchanged and unreadable for history/agent discovery. Hash checks for 5L through 5P remain intact. Before committing, run all verification commands and inspect the staged filenames. Before any commercial activation, verify real cross-organization denial/revocation with the restricted database role and complete ingress/agent-enrollment review. **PUBLIC LAUNCH: NO_GO.**
