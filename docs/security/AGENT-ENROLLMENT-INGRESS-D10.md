# Pulse Metrics — Phase 2E3C5D10: agent enrollment ingress and distributed quotas

**Status:** Candidate and isolated rehearsal ONLY
**Reviewed Git checkpoint:** `0a128bbd49d302fbb6e4918412d5ba02c895d9d8`
**Public enrollment:** DISABLED
**Public launch:** **NO-GO**

## Purpose and scope

Introduce a separately versioned `0002` agent enrollment ingress quota migration, a reusable PostgreSQL-backed quota adapter, and explicit transport/authorization middleware. All new components remain **unmounted**. The active Express application, WorkOS middleware, browser holding boundary, original Drizzle migration, original six privileged SQL steps, and prior `0001` enrollment migration remain unchanged.

D9's `verify-candidate.mjs` requires exactly one SQL file in `scripts/agent-enrollment/migrations/`. To preserve that immutable check, D10's `0002` SQL is in **`scripts/agent-ingress/migrations/`** with a separate SHA256 lock, while the *database* receipt for `0002` is atomically recorded in `pulse_agent_enrollment.schema_migrations` alongside D9's `0001` receipt. Both are applied only inside a marked, disposable Unix-socket-only PostgreSQL cluster.

## Security design

- **Verified transport:** `direct-tls` accepts only an encrypted Node socket; `trusted-proxy` requires the immediate peer address to match an exact CIDR allowlist, a valid unambiguous `X-Forwarded-For` chain, and precisely one `X-Forwarded-Proto: https` field. Untrusted forwarding headers are never proof of TLS. The trusted reverse proxy must **overwrite**, never pass through, the latter two headers and restrict direct access to the app origin.
- **Pre-auth network quota:** mandatory for both issuer and redeemer. The rate limiter uses the independently resolved network identity. A deployment must apply the trusted WorkOS token-verification middleware between issuance network and actor guards; no `x-test-actor` style header may ever be accepted in production.
- **Verified actor quota:** issuance requires a verified WorkOS identity and an independent per-actor rate-limit bucket after network admission. The organization owner/admin decision remains in D9's restricted PostgreSQL security function. A supplied organization or role in a request body is never authorization.
- **Independent buckets:** HMAC-SHA256 over a domain-separated action/kind/identity. PostgreSQL receives **only** 64-char HMAC digests, never raw IP addresses, WorkOS subjects, enrollment tokens, or machine credentials. Identical 32-byte HMAC keys are required across API instances. The key must be secret-managed, not committed, logged or returned.
- **Fixed limits:** `issue/network=40`, `issue/actor=8`, `redeem/network=25` attempts per 15 minutes. The database itself sets limits; callers cannot raise ceilings, choose other action/kind pairs, or change windows. An `INSERT ... ON CONFLICT ... DO UPDATE` serializes concurrent consumption across workers. Excess returns HTTP 429; storage outage, malformed data, missing trusted transport or invalid deployment state returns HTTP 503.
- **Least privilege:** an additional `NOLOGIN NOINHERIT BYPASSRLS` executor with no memberships receives only the minimum table grants. The counter table has `ENABLE` and `FORCE` RLS with no policies and no direct runtime grants. The fixed function is SECURITY DEFINER with `search_path=pg_catalog,pg_temp`; `PUBLIC` cannot execute it. Receipt and migration are one PostgreSQL transaction.
- **Fail-closed by construction:** `createAgentEnrollmentIngressGuards` requires `isolatedTestOnly: true` and `production: false`. Any production attempt fails regardless of supplied configuration. The middleware keeps its proof state in a private `WeakMap<Response>` so another middleware cannot forge it by writing a public `res.locals` field. It supplies the D8 `agentEnrollmentIngressVerified` compatibility marker only once the full chain passes.

## Intended future route assembly (not enabled)

For `POST /api/organizations/:organizationId/agent-enrollments`: ingress network guard (`issue`), real WorkOS bearer verification, ingress actor guard, ingress final admission (`issue`), then D8 issuance route. For `POST /api/agent-enrollments/redeem`: ingress network guard (`redeem`), final admission (`redeem`), then D8 redemption route. The redeem route must be mounted **before** a global human-auth middleware and must receive separate edge protections. Neither route is mounted in `server.ts` today.

Do not change these candidate guards to allow production until the independent release authorization is complete and all security and operational controls below have evidence.

## Test and deployment approval gates

1. **Source:** `node scripts/agent-ingress/verify-ingress-candidate.mjs` verifies D9 and D10 SQL digests, Git blob pins and disabled enrollment routes. `node --test scripts/agent-ingress/verify-ingress-candidate.test.mjs` verifies 11 static regression cases.
2. **Application:** `npm test`, `npm run lint`, `npm run build`, `npm run db:check`, historical privileged migration manifest tests, and whitespace checks. Static checks are not an independent penetration test.
3. **Isolated PostgreSQL:** `bash scripts/test-agent-ingress-rehearsal.sh` repeats the six-step historical replay, applies D9 then D10 candidate **only** to a newly created socket-only cluster, tests distinct bucket ceilings and 35 simultaneous clients, HTTP proxy simulations and authorization, least privilege, and teardown. Existing local database is read-only baseline-audited before and after.
4. **Migration release:** separately approved immutable plan, an independent reviewer, exact source/ledger preflight, backup and recovery rehearsal, a single migration coordinator, post-migration verification and non-destructive forward-only recovery. Do not casually rerun the candidate SQL against any existing database.
5. **Real HTTPS edge:** externally reachable TLS and certificate chain tested, trusted proxy configuration confirmed with direct-origin isolation; spoofed, missing, duplicated and malformed forwarding fields denied. Loopback *simulated* proxy tests do not certify this.
6. **Real WorkOS and role separation:** verifier and session checks in staging, authenticated issuance only for permitted owners/admins, anonymous redemption never assumes organization, cross-organization negative tests, revocation and replay tests. Verify API middleware ordering in the actual deployed entrypoint.
7. **Distributed quota operations:** shared key custody/rotation, multi-replica concurrency, storage outage response, DoS and NAT impact, privacy and HMAC-only logging, quota alerting and durable retention/cleanup of expired rows. Current candidate has **no scheduled cleanup**, so operational rollout is blocked.
8. **One-time secret lifecycle:** strict no-store headers, TLS, secure agent-side credential file permissions, non-logging/non-URL delivery, rotation/recovery workflow, backup containment, agent binary integrity and host privileges.
9. **Production launch:** independent security review, staging soak, monitoring and incident response signoff, consent/privacy policies, durable telemetry ingest and tenant-scoped read authorization. **NO-GO** until independently evidenced.

## Explicit limitations

- No production migration is applied or scheduled. No live API route or reverse-proxy configuration is modified. No real certificate, WorkOS token or external network path is used in the rehearsal.
- The D10 quota candidate is not an intrusion-prevention system, WAF or sufficient application-level authorization. Counters are retained until separately reviewed maintenance exists. Raw tokens are never persisted in quota state.
- The HTTP rehearsal uses a synthetic identity fixture and simulated proxy headers **only** over loopback. That is intentionally different from asserting that internet-facing TLS is correctly deployed.
- Current monitoring endpoints and WebSockets remain disabled; no simulated metrics are presented as real telemetry.

**Rollback policy:** Never drop customer credential, quota or migration data merely because a client lost a success response. Reconcile under an approved lock and use separately reviewed forward corrections. The isolated test harness may destroy only its own marked disposable cluster.
