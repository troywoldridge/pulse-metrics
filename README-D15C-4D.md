# Pulse Metrics — D15C-4D combined HTTP / PostgreSQL rehearsal

**Status:** REVIEW ONLY. UNMOUNTED. PUBLIC LAUNCH: **NO_GO**.

## Purpose

This is a fully disposable rehearsal of the actual (not mocked) PostgreSQL
`pulse_telemetry_ingestion.ingest_submission` function through the real
TypeScript SQL gateway and isolated Express candidate.

It extends the existing D15C-4B *disposable cluster bootstrap* in a **new,
complete script**; it does not overwrite any historical migration, the D15C-4B
rehearsal, server.ts, or runtime configuration.

### New complete files

- `scripts/test-telemetry-agent-quota-http-rehearsal.sh` — standalone launcher;
  replays the historical migrations into a temporary Unix-socket PostgreSQL
  instance, validates D15C-4B, then runs D15C-4D before cleanup.
- `scripts/telemetry-agent-quota/http-postgres-integration.ts` — performs real
  restricted-role SQL through the TypeScript gateway, sending synthetic
  telemetry to a loopback-only, test-admitted HTTP endpoint.

## Prerequisites

The project must already have the successful D15C-4B and D15C-4C files
installed, plus the existing historical source-manifest verifiers. Use a
local development environment only. This launcher inspects the `.env`
configuration, but does **not** connect to the configured DATABASE_URL.

## Installation and checks

```bash
cd ~/Projects/pulse-metrics
unzip -l ~/Downloads/pulse-metrics-d15c4d-real-http-postgres-rehearsal.zip
unzip -n ~/Downloads/pulse-metrics-d15c4d-real-http-postgres-rehearsal.zip

bash -n scripts/test-telemetry-agent-quota-http-rehearsal.sh
node --experimental-strip-types --check scripts/telemetry-agent-quota/http-postgres-integration.ts
npm run lint

# May prompt for sudo. Creates a temporary PostgreSQL server with TCP off.
bash scripts/test-telemetry-agent-quota-http-rehearsal.sh
```

No manual SQL installation. No production mounting. Do not bypass a
failed safety check.

## Expected behavior (verified only if rehearsal passes)

- New valid submission: HTTP **202** and persisted telemetry.
- Exact authenticated replay: HTTP **200** without consuming agent quota.
- Reused submission ID with altered payload: HTTP **409** and quota charge.
- 122 concurrent valid HTTP submissions after two prior charges: exactly
  **118 inserted** and **4 denied with HTTP 429** and bounded Retry-After.
- Duplicate still acknowledged when agent quota is exhausted.
- Another tenant can submit the same UUID independently.
- Revocation prevents replay.
- Private quota counters are inspected through the administrator wrapper only
  after the test and must match the expected durable values.
- The disposable PostgreSQL cluster is stopped and removed.

### Known blocker discovered by design review

The current gateway maps database SQLSTATE `42501` to a generic **503**,
including authentication denial from the protected function. It must **not**
blindly convert all `42501` errors to HTTP 401: that same SQLSTATE can mean
SQL privilege failure. This rehearsal explicitly expects the current
**fail-closed 503** for unknown and revoked credentials. A future revised
versioned SQL protocol should distinguish authentication denial from
operational failures so that a generic HTTP **401** can be returned safely.

This is not a production security approval: loopback HTTP has no actual TLS,
proxy hardening or operational load validation. Agent uploader, quota retention,
production migration procedure, ingress middleware ordering and public API
activation remain separate blocked milestones.
