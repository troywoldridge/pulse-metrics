# Pulse Metrics — D15C-4C: Authenticated agent quota HTTP mapping

Status: **REVIEW ONLY / UNMOUNTED / PUBLIC LAUNCH NO_GO**

## Verified input

The user ran the D15C-4B PostgreSQL disposable cluster rehearsal with success:
- 135 concurrent authenticated submissions: 120 inserted, 15 rate-limited.
- Independent agent and tenant quotas, exact duplicate behavior, revocation denial.
- D15B privileges and receipt preserved, temporary cluster cleaned up.

This does not show that the runtime HTTP gateway was updated, or that a public deployment is safe.

## Source changes

**Complete replacement files** (not patches):
- `src/server/telemetry/postgres-ingestion.ts`
- `src/server/telemetry/http-ingestion.ts`

**New test:**
- `src/server/telemetry/agent-quota-http.integration.test.ts`

**Bundled D15C-4A prerequisites** (complete original versions, so the package also works if D15C-4A wasn't extracted):
- `src/server/telemetry/ingestion-outcome-v2.ts`
- `src/server/telemetry/ingestion-outcome-v2.test.ts`
- `docs/project/D15C-4-AGENT-QUOTA-DESIGN.md`

## Expected behavior

| Database function outcome | Gateway | HTTP |
|---|---|---|
| `inserted` | return `inserted` | 202 |
| `duplicate` | return `duplicate` | 200 |
| `conflict` | throw conflict | 409 |
| `rate_limited:45` | throw typed quota error | 429 + Retry-After: 45 |
| malformed result or SQL failure | throw sanitized error | 503 |

Other HTTP validation and private admission remain unchanged.

## Safe local installation

The two existing source files are intentionally rewritten end-to-end. Confirm the branch and a clean tree before installing. Unzip will replace those complete files; `unzip -o` should not be run on a project containing local changes you want to keep.

```
cd ~/Projects/pulse-metrics

git status -sb
unzip -l ~/Downloads/pulse-metrics-d15c4c-agent-quota-http.zip
unzip -o ~/Downloads/pulse-metrics-d15c4c-agent-quota-http.zip

node --import tsx --test src/server/telemetry/ingestion-outcome-v2.test.ts src/server/telemetry/agent-quota-http.integration.test.ts
npm run lint
npm test
npm run build
git diff --check
git status -sb
```

**Do not commit if checks fail.** Do not apply SQL to normal dev or production. Do not mount the endpoint in server.ts.

## Remaining deployment blockers

- Production migration strategy and rollback/forward recovery approval.
- TLS/proxy assurance, global parser ordering, HTTP rate/quota integration.
- Agent uploader and persistent outbound queue with bounded retries.
- Run an integrated disposable SQL -> gateway -> HTTP test (the new HTTP test uses a synthetic SQL executor).
- Independent quota cleanup, storage retention, monitoring, auditing, connection capacity and genuine load testing.

The integration test in this package uses synthetic SQL returns. D15C-4B independently tested real PostgreSQL. This package has been source/syntax checked in the authoring environment, but must pass the user's project suite locally before any commit.
