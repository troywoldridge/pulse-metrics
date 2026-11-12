# Pulse Metrics — Phase 2E3C5D7: Isolated Agent Enrollment & Credential Foundation

**Status:** Test-only PostgreSQL credential lifecycle rehearsal. **NOT** a production migration, enabled API, certificate authority, network service, or public-launch approval.

**Reviewed baseline:** Git commit `04358633db19bafca16666af10983f9e32a0e4a7` on `feat/identity-organization-onboarding`. The existing six privileged SQL steps and Drizzle history are pinned and replayed without rewriting them.

## Scope and trust boundaries

1. Browser human authentication remains WorkOS AuthKit. The backend receives a verified WorkOS subject from its existing bearer middleware. The SQL functions do not verify JWTs; the rehearsal uses explicit **synthetic fixture** subjects instead of authentic user sessions.
2. Every agent belongs to exactly one organization via the existing `monitored_agents` composite FK and credential organization/agent relationship. Enrollment **does not accept a browser-provided organization during token redemption**; the organization comes from the locked enrollment token record.
3. Enrollment and machine secrets are independent, cryptographically generated 32-byte random values, canonical 43-character base64url strings. SHA-256 of a high-entropy secret is stored; the raw value is not stored. The 12-character display prefix comes from the digest, never the raw secret. These are machine secrets, **not passwords**.
4. A human owner/admin of the matching organization may issue a 10-minute single-use enrollment token. Members/viewers and owners of another organization are rejected by PostgreSQL, independently of UI controls.
5. Redemption takes a row lock and uses one transaction to mark a token consumed, create its organization-owned agent, create the first `telemetry:write` credential (30-day expiration) and append a synthetic audit event. Two concurrent redeemers must yield exactly **one success**.
6. Machine credentials are verified by a hash-only lookup; the verified organization and agent are returned **from the database record**, never from an untrusted claimed organization ID. Unknown/expired/revoked credentials return no identity. This is only a test contract: there is no telemetry endpoint yet.
7. Rotation revokes previous active credentials and issues a new hash in one transaction after an owner/admin and agent-state check. Agent revocation invalidates all active credentials, marks the agent revoked and appends an audit event. Revocation is idempotent.
8. `pulse_agent_rehearsal_executor` is a test-only NOLOGIN/NOINHERIT, BYPASSRLS role with no members and limited column grants. SECURITY DEFINER routines fix their search path to `pg_catalog, pg_temp`. The ordinary application runtime role cannot directly read enrollment/credential tables or write monitored agents.

## What it does NOT do

- **No production schema changes.** The five `pulse_agent_rehearsal` routines and synthetic executor role exist only in a freshly created, marker-verified disposable PostgreSQL cluster.
- **No public HTTP routes** for issuance, redemption, verification, rotation, revocation or telemetry. Existing server still denies unknown `/api` requests and WebSocket upgrades.
- **No raw credential delivery or installation UX.** Future agents must receive the secret over verified TLS, store it with least-privilege OS file permissions/secret store and never log it. Browser URLs, email and terminal output are inappropriate transport for persistent machine credentials.
- **No production credential rate limiting or abuse defense.** Before any endpoint is mounted, add carefully designed pre-auth network quotas, bounded enrollment attempts, post-auth actor quotas, safe error uniformity, audit for failures, and trusted-proxy review.
- **No production access control for the test functions.** Test `issue_enrollment()` accepts a subject string because its caller is the isolated harness. A future API must pass only an independently verified subject; arbitrary user-supplied subjects would create a critical privilege bypass. Do not enable this SQL in any real database.
- **No ingestion transaction binding.** In production, credential validation and telemetry persistence must be race-safe, enforce credential scope, validate payload size/schema/time/freshness, handle idempotency, and prevent a revoked machine from writing afterward. This rehearsal proves only the credential-state lifecycle.
- **No real support for credential custody, rotation grace periods, device attestation, mTLS, reinstall, credential compromise recovery, agent package signing, installer authorization, multi-host agent deployment or fleet operations.**
- No customer data, genuine agent identities, recovery secrets, production passwords or actual WorkOS tokens are used.

## Why the database isn't touched

`bash scripts/test-agent-enrollment-rehearsal.sh` first verifies the pinned original SQL manifest and runs the existing read-only adoption-drift security audit. It then builds a **separate PostgreSQL cluster** in `/tmp/pulse-replay-XXXXXXXXXX`, using peer-authenticated Unix sockets, disabled TCP, explicit role checks, an isolated marker and a guarded cleanup trap. It replays the original Drizzle migration and six original privileged SQL steps, verifies the pinned public schema hash, installs the test-only SQL, creates two synthetic organizations and calls the functions through the non-superuser `pulse_metrics_app` role. It audits permissions, receipts, RLS and fixture counts, compares the original local development database against its pinned read-only catalog fingerprint and destroys the temporary cluster. If safe cleanup fails, it reports the temporary path and returns failure.

PostgreSQL integration must be run and reviewed on the development Linux machine; it has **not** been executed in the packaging environment. This package includes no production SQL migration and changes no real database roles or privileges.

## Verification checklist

- `npm test` includes the new token-shape / random-generation / untrusted-shape tests; existing 185+ application tests must still pass.
- `node --check scripts/agent-enrollment/rehearsal-integration.mjs`
- `bash -n scripts/test-agent-enrollment-rehearsal.sh`
- `bash scripts/test-agent-enrollment-rehearsal.sh`: original read-only security audit, disposable cluster and realistic concurrency + cross-tenant tests.
- `npm run lint`, `npm run build`, `npm run db:check`, `node --test scripts/migrations/verify-manifest.test.mjs` must pass.
- `git diff --check` and staging review must pass. **No commit** until results are reviewed.

## Next milestones, before any live enrollment

1. Review and version an actual **privileged production migration** compatible with the existing Drizzle/privileged manifest and recovery gates; no ad-hoc `007` execution or mutation of the six pinned originals.
2. Build authenticated *owner/admin* issuance and revocation routes with pre-auth and actor rate limiting; generic errors, no user-controlled verified subject, recheck membership in SQL.
3. Design a separately rate-limited machine enrollment endpoint over verified TLS. Deliver only one-time credentials and deny reuse/expiry/revocation/concurrent replay.
4. Bind machine credential verification (including `telemetry:write` scope) to the **same transaction** that inserts a validated versioned telemetry sample. Test revocation versus in-flight ingest, multi-tenant cross-access and duplicate submissions.
5. Validate real Linux agent credential storage, rotation, upgrades, opt-in installation and end-to-end telemetry reading; then implement authorized monitoring API/dashboard and WebSocket tickets.
6. Complete staging security review, offsite recovery, CI provenance, production transport, privacy/retention, operational support and release gates.

**Release status: `NO_GO` for customer access and public launch.** Passing this synthetic rehearsal does not imply an approved production release.
