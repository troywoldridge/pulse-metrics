# Pulse Metrics — D15C-4E: Distinguish invalid machine credentials

**Status: review-only, not deployed or mounted. Public launch: NO_GO.**

This candidate fixes the observed D15C-4D HTTP status gap: a credential that
PostgreSQL definitely rejects should produce a generic **401**, not **503**.
A driver exception or generic SQLSTATE 42501 must **still** yield **503**.

## Design

- Use an explicit `credential_unavailable` result **only within the protected**
  `pulse_telemetry_ingestion.ingest_submission` function.
- Change exactly three existing rejection branches: unknown credential,
  inactive agent, expired/revoked/missing-scope credential.
- Retain lock order, scope checking, tenant binding, idempotent duplicates,
  120/60s agent quota, table ACLs and standalone-autocommit requirement.
- Version 0002 goes into the existing private `pulse_telemetry_agent_quota`
  migration ledger. The locked 0001 D15C-4B file stays byte-identical.
- Function ownership, signature and privileges remain unchanged.
- No real credentials or customer data in tests. No mounted production routes.

## Install files

From `~/Projects/pulse-metrics`:

```bash
unzip -l ~/Downloads/pulse-metrics-d15c4e-auth-rejection.zip
unzip -o ~/Downloads/pulse-metrics-d15c4e-auth-rejection.zip
```

The archive intentionally contains **complete replacements** for the five
existing files that implement the outcome parser, the gateway, parser tests,
real-HTTP/DB integration and the disposable rehearsal. Review `git diff` before
using them if you have made additional edits.

## Static and application checks

```bash
node scripts/telemetry-auth-outcome/verify-candidate.mjs
bash -n scripts/test-telemetry-agent-quota-http-rehearsal.sh
node --experimental-strip-types --check scripts/telemetry-agent-quota/http-postgres-integration.ts
npm run lint
npm test
npm run build
```

## Disposable PostgreSQL rehearsal

**Only** after the static checks succeed:

```bash
bash scripts/test-telemetry-agent-quota-http-rehearsal.sh
```

This tests forced rollback, source hash, duplicate install rejection, private
ledger, function body, ACLs, real unknown/revoked-credential HTTP 401, quotas,
revocation and temporary database cleanup. The preflight refuses ordinary DBs.
Never manually run the SQL or change the local database to make a test pass.

**Pinned SQL SHA256:** `3061f797a7d1fa0dfb335130252c4d89a3d1ee50d263854a22caa2a6c4d8c771`
**Base D15C-4B function body SHA256:** `6ca2ea99b727df12e737593d31a96238d98d81df6d2f461cdbad902002888e28`
**New D15C-4E function body SHA256:** `04abf246ad3c10b3352c2cc52165a70c5f736d2280452bb4e0c02d84e04774e2`

Keep the source uncommitted until the disposable real PostgreSQL rehearsal and
application checks pass. Production activation remains prohibited.
