# Pulse Metrics — D15C-4B Agent Quota SQL and Rehearsal

**Status:** Review-only, disposable PostgreSQL only. **Public launch: NO_GO.**

This package is a NEW migration series. It does not modify original pinned D15B
or D15C-3 SQL, the network quota adapter, or the HTTP server.

## Contents (complete new files)

- `scripts/telemetry-agent-quota/migrations/0001_telemetry_agent_quota.sql`
  - Independent, strictly preflighted, atomic privileged migration.
  - Requires D15B + D15C-3 network quota installed in a disposable cluster.
  - Replaces the existing PostgreSQL `ingest_submission` function **in that
    disposable cluster only**, preserving its OID, owner, schema, arguments and
    permissions. The original function body is fingerprint-checked first.
  - Maintains credential authorization and agent-before-credential row locks.
  - Makes exact duplicates free, conflicts chargeable.
  - Fixed provisional agent allowance: **120 chargeable attempts / 60 sec**.
  - Returns `rate_limited:N` (1..60) without throwing an error on exhaustion.
- `scripts/telemetry-agent-quota/migrations/manifest.json`
  - Pinned source identity and SHA256.
- `scripts/telemetry-agent-quota/verify-candidate.mjs`
  - Read-only source and manifest verifier.
- `scripts/telemetry-agent-quota/agent-quota-integration.mjs`
  - Restricted-application-role, concurrent, synthetic-fixture tests.
- `scripts/test-telemetry-agent-quota-rehearsal.sh`
  - Full **end-to-end rewrite** of the temporary-cluster rehearsal logic,
    deliberately installed as a new file, leaving older rehearsals intact.
  - Initializes isolated Unix-socket PostgreSQL with TCP off, replays the
    original protected migrations, installs D15B and the network quota,
    checks rollback and grants, installs this candidate, tests concurrency,
    and removes the disposable cluster.

## Run locally

From your existing Pulse Metrics checkout (after extracting with `unzip -n`):

```bash
node scripts/telemetry-agent-quota/verify-candidate.mjs
bash -n scripts/test-telemetry-agent-quota-rehearsal.sh
node --check scripts/telemetry-agent-quota/agent-quota-integration.mjs
bash scripts/test-telemetry-agent-quota-rehearsal.sh
```

**Never** run this migration with `psql -f` on your working/customer database.
The isolated launcher uses hardcoded, verified temporary paths and rejects
unexpected targets. Do not relax or bypass a failure.

## Ingestion and caller contract

The existing application gateway currently recognizes only `inserted`,
`duplicate`, and `conflict`. The new `rate_limited:N` outcome is NOT integrated
into the HTTP stack, and the candidate is **UNMOUNTED**. The complete files
`src/server/telemetry/postgres-ingestion.ts` and
`src/server/telemetry/http-ingestion.ts` will need a separate reviewed rewrite
and HTTP test before any activation.

Quota denials are returned, not raised, to preserve their counters. The future
caller must use the ingestion function in a standalone autocommit statement;
application-initiated transactions that later roll back can undo quota charges.
If a later SQL statement fails, the entire statement's quota update rolls back:
this design is a *successful admission/explicit quota-denial* quota, not a
payment-grade record of every rejected attempt.

This is not a denial-of-service control by itself. Proxy enforcement, HTTP
limits, connection caps, quota cleanup, storage retention, auditing, revocation
race tests and production migration/recovery procedures are still required.

## Rehearsal evidence targets

- Forced SQL failure rolls back replaced function, grants, schema, role, ledger.
- Duplicate migration is rejected.
- App role denied quota counters, direct quota function, owner impersonation.
- 135 concurrent submissions produce exactly 120 inserts and 15 quota denials.
- An additional denied new submission persists its quota accounting.
- Duplicates of a previously inserted sample are still admitted when capped.
- Changes to an existing submission ID return `conflict` and count.
- Two organizations and two agents in one org have isolated counters.
- Unknown/revoked credentials and malformed metrics are refused.
- D15B original privileges and migration receipt remain valid.
- The entire cluster and temporary copies are removed upon exit.

**The authoring environment has not run the real PostgreSQL rehearsal.**
Treat every test scenario above as a target until a local run reports success.
