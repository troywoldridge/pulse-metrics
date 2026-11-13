# Pulse Metrics — D15C-4 Authenticated Agent Quota Design

**Status:** Proposed, review-only. No installation or activation.
**Date:** 2026-11-13
**Public launch:** NO_GO

## Current reviewed baseline

- Git checkpoint `52e8c24` contains the isolated PostgreSQL network-quota candidate.
- D15B's original pinned SQL has an `ingest_submission(...) RETURNS text` function.
- It currently returns `inserted`, `duplicate`, or `conflict`.
- D15B verifies the credential hash, resolves tenant and agent identity from database state, locks the agent row with `FOR SHARE`, then rechecks and locks the credential row with `FOR SHARE`.
- D15B uses a transaction advisory lock per `(organization, agent, submission)` before reading previous submissions.
- The D15B source verifier allows only its original `0001_telemetry_ingestion.sql`. Do **not** alter it or add a file to its locked directory.

## Proposed semantics (must be verified in real PostgreSQL)

1. Reject malformed telemetry independently of the network and agent quota limits.
2. Apply the separately committed D15C-3 network quota ahead of JSON parsing and credential authentication.
3. Within a new versioned protected ingestion function, derive tenant and agent solely from the credential digest. Preserve D15B's agent-before-credential lock order and credential-scope, revocation and expiration checks.
4. Under the per-submission lock, return `duplicate` for an exact replay **after credential reauthorization**. Exact duplicate acknowledgments do not consume the agent's *new-submission* quota; the independent network quota still accounts for every HTTP request.
5. Charge the agent's quota for each nonduplicate submission attempt, including conflicts, before accepting the insert or returning `conflict`.
6. If the quota is exhausted, return `rate_limited:<retry_after_seconds>` with an integer from 1 through 900. **Do not raise an exception merely for quota exhaustion**, since an exception would roll back the counter update.
7. For allowed new submissions, retain the existing telemetry insert and submission ledger behavior. Preserve the unique key and lock ordering.
8. Database errors and unexpected return values must fail closed; no identity, SQL diagnostics or credentials are disclosed.

## Migration and runtime boundary

- Create a **separate, versioned and fingerprint-pinned migration series** for D15C-4. Retain all original D15B SQL bytes unchanged.
- Use dedicated private agent quota counters keyed by verified `organization_id` and `agent_id`, not user-supplied IDs or raw machine credentials.
- Keep the quota table inaccessible to `pulse_metrics_app`; a narrowly privileged `SECURITY DEFINER` function must perform the update.
- Freeze the new function signature and outcomes through controlled migration; do not create an alternate callable path that bypasses quotas.
- Validate that earlier installation receipts and security ownership remain intact, and that unauthorized direct table access and function execution are denied.
- The rate-limit update and its denial result must **commit together**. The production SQL executor for this operation must use a standalone autocommit statement rather than wrapping it in a transaction that application code might later roll back.
- The fixed numeric ceiling and time window are provisional and should be based on an expected agent reporting cadence with allowance for bursts. Avoid arbitrary assumptions about all customers sharing identical cadence.
- Network and agent quotas are independent: the network bucket is an opaque HMAC digest, while agent buckets use database-verified UUIDs that must remain private.

## Outcome contract

The proposed backward-compatible PostgreSQL text outcomes are:

| SQL result | Meaning | Expected future HTTP behavior |
|---|---|---|
| `inserted` | Valid new sample persisted | 202 |
| `duplicate` | Valid previously persisted exact submission | 200 |
| `conflict` | Same submission ID with different content | 409 |
| `rate_limited:45` | Agent's new-submission quota exhausted | 429 with `Retry-After: 45` |

The accompanying `ingestion-outcome-v2.ts` is **only a parser contract**, not yet wired to the D15B gateway or HTTP handler. Existing code therefore continues to fail closed on new/unrecognized SQL outcomes. The future gateway and HTTP handler will require complete-file updates after the real SQL migration and rehearsal are validated.

## Rehearsal acceptance cases

- Existing ordinary D15B installation and permissions are unchanged.
- New versioned SQL installation refuses non-disposable clusters, unexpected role owners, duplicate application, and source fingerprint drift.
- Forced failure rolls back all new schema, grant and receipt changes.
- The runtime role cannot read quota counters, alter them directly, assume definer roles, or bypass the new protected ingestion function.
- Invalid, expired, wrong-scope, revoked and cross-tenant credential attempts never ingest telemetry.
- Agent revocation races with ingestion are serialized without deadlocks or post-revocation inserts.
- Exact valid retries remain duplicate, do not add telemetry rows and do not consume the agent *new-submission* quota.
- Distinct new submissions consume fixed allowance across multiple concurrent restricted-runtime connections, with no over-admissions.
- Conflicting submission IDs are charged and never overwrite earlier telemetry.
- Quota exhaustion returns a committed, strict `rate_limited:N` outcome with no inserted telemetry.
- Rejections and recovery preserve independent counts for two organizations and two agents.
- Directly test SQL errors to ensure driver diagnostics are not returned over HTTP.
- Cleanup removes the temporary PostgreSQL cluster; production and ordinary development databases remain untouched.

## Known limitation

A database quota is one control, not an entire denial-of-service defense. Network proxy limits, TLS identity, read/body timeouts, per-request size caps, maximum concurrent connections, retention cleanup, protected metrics and operational alerting remain essential. **Public launch: NO_GO.**
