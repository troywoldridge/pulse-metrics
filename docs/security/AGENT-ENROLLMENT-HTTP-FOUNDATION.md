# Pulse Metrics — Phase 2E3C5D8 Agent Enrollment HTTP Foundation

**Status:** Implemented as an **unmounted** application/test foundation; **NO-GO** for public agent enrollment.

**Reviewed Git baseline:** `89e86acc409a44c75671de2cfb29c4e6b0159ac0`

**Scope:** New, additive TypeScript service/HTTP contract and a loopback-only synthetic HTTP-to-database rehearsal. Existing production-oriented API registration, database migration history, PostgreSQL roles, user data, WorkOS middleware, WebSocket rejection and Linux collector remain untouched.

## What is implemented

- `src/server/agent-enrollment-service.ts` uses an **explicitly injected** `EnrollmentGateway`. Issuance creates a fresh 32-byte random one-time secret and passes only its SHA-256 hash/prefix to the gateway. Redemption generates a **different** machine credential server-side and passes only its hash/prefix to the gateway. The raw credential is only returned after successful persistence. The client cannot choose the machine credential, scope, organization or role.
- `src/server/agent-enrollment-routes.ts` exposes two **unmounted** factory functions: a WorkOS-identity-backed issuance route and a machine-facing redemption route. They require an explicit ingress admission marker (`res.locals.agentEnrollmentIngressVerified === true`), set only by a future independently reviewed TLS/network/actor rate-limit middleware. Without that marker, **both routes return 503 before invoking any service**. They also require exact JSON request fields, reject unsupported media, sanitize errors, set `Cache-Control: no-store` and never print secrets.
- `src/server/agent-enrollment-routes.test.ts` covers request validation, failure modes, secret transformation, unauthorized or cross-tenant denial mapping, no-store headers and unexpected results using injected fake data gateways. These tests are part of `npm test`.
- `scripts/agent-enrollment/http-integration.ts` uses real Express HTTP and a restricted `pulse_metrics_app` socket connection to the **Phase 2E3C5D7 test-only** SQL functions. It tests synthetic role restrictions, issuance, two simultaneous redemption HTTP requests (one succeeds), replay denial, credential verification and revocation. It deliberately sets the test-only ingress admission marker and impersonates synthetic WorkOS subjects via `x-test-actor` **only inside the loopback-only disposable rehearsal**; neither mechanism MUST EVER be copied into production API middleware.
- `scripts/test-agent-enrollment-http-rehearsal.sh` is a **full, independent shell harness** built from the already passing D7 disposable-cluster test. The original tests, six-step migration replay, read-only developer-database catalog audit, security invariants and guarded cluster cleanup run before the additional HTTP integration test. It does not execute any enrollment SQL against the real developer database.
- `scripts/agent-enrollment/http-source-guard.mjs` checks pinned protected Git blobs and documented contract patterns; it is only a static regression check, **not** proof of endpoint security.

## The intended HTTP request contracts (NOT live routes)

1. **Organization-admin issuance**: intended `POST /api/organizations/:organizationId/agent-enrollments`, after trusted WorkOS token verification and pre-auth network / post-auth actor rate limits. Body: `{ "label": "Office Linux Agent" }`. Successful response has `enrollmentId`, `organizationId`, `expiresAt` and `oneTimeToken`. PostgreSQL must independently check membership and owner/admin roles.
2. **Machine redemption**: intended `POST /api/agent-enrollments/redeem`, after independently reviewed TLS termination and **pre-auth network rate limiting**. Body: `{ "token": "<43-char secret>", "agent": { "displayName": "Office Linux Agent", "hostname": "office-01.example", "platform": "linux", "architecture": "x86_64" } }`. Successful response has `organizationId`, `agentId` and `machineCredential`, issued only once. Any lost credential response requires a **new enrollment**; never replay/reveal stored secrets.

**DO NOT mount either route now.** The current reviewed server's authentication ordering and local-only binding remain unchanged. The handler factories require a verified ingress marker but do not themselves enforce TLS, rate limits, machine admission policy or production-secret delivery. They fail closed until a separately reviewed real ingress layer sets that marker. The `EnrollmentGateway` is deliberately **not implemented against the real development database**, because no reviewed versioned production-ready agent-enrollment migration exists there yet. No customer enrollment flow can operate from this package.

## Security controls and limitations

- Verified human identity must come only from real WorkOS middleware. HTTP tests use synthetic identities solely inside the test harness.
- The future SQL function, not a browser claim, must be the final authority on organization membership, agent ownership, token use and credential revocation. The D7 function uses `FOR UPDATE` to serialize one-time token consumption.
- Never accept organization ID, user ID, role, credentials or hashes inside the redemption request. Never put enrollment tokens in URLs, logs, analytics, browser storage or error bodies.
- Token rotation/revocation routes are **not implemented** in this phase. D7 test-only SQL exercises their database behavior. Production migration/versioning, rate limits, TLS, secure agent credential storage/update, service bootstrap and telemetry submission are all **still pending**.
- The synthetic HTTP test binds only `127.0.0.1` with an ephemeral port. The test-mode identity header is never installed in `server.ts`. Test TCP is local only; PostgreSQL itself uses only the verified Unix socket.
- The read-only baseline audit verifies the existing developer DB schema catalog before and after. A matching catalog is not a checksum of all data; the test harness issues no write statements against that database.

## Verification commands

Run only from the reviewed clean commit on the pinned branch after installing this additive package. **Never run the SQL manually on the working development DB.**

```bash
node --test scripts/agent-enrollment/http-source-guard.test.mjs
node scripts/agent-enrollment/http-source-guard.mjs
npm test
node --check scripts/agent-enrollment/http-source-guard.mjs
bash -n scripts/test-agent-enrollment-http-rehearsal.sh
bash scripts/test-agent-enrollment-http-rehearsal.sh
npm run lint
npm run build
npm run db:check
node --test scripts/migrations/verify-manifest.test.mjs
git diff --check
```

A passing test validates only the behaviors covered. Before commit: inspect `git diff --cached`, check exact file additions, verify no secrets/temporary files, then commit and push the reviewed branch. No public deployment or DB adoption action is authorized by passing tests.

## Required next engineering/release stages

1. Design, hash-pin, test and independently approve a **versioned** privileged migration for the actual enrollment role/functions, with durable release ledger, documented rollback and a migration/adoption protocol. Do not modify the immutable six prior migrations.
2. Implement the production `EnrollmentGateway` using the restricted app role and real versioned SQL entrypoints. Verify all function grants, RLS isolation, malformed-input handling, privilege escalation resistance and race/revocation behavior in a fresh cluster.
3. Add hardened pre-auth network and post-auth actor rate limiting that works across instances, plus TLS/certificate and reverse-proxy trust boundaries. Test hostile callers before mounting any public route.
4. Implement safe one-time secret delivery, agent-side credential lifecycle and recovery after lost acknowledgments, then enable and test the genuine Linux agent.
5. Build authenticated telemetry ingest and tenant-scoped reads; maintain WebSocket `403` rejection until verified organization-safe subscriptions exist.
6. Complete deployment, monitoring, logging/secret redaction, penetration/abuse review and the commercial release checklist before a public `GO` decision.
