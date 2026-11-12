# Pulse Metrics — Phase 2E3C5D13 Pre-Authorized Agent Identity

**Status:** Versioned database migration candidate, unmounted service and route foundation.

**Public launch: NO-GO.** No working database migration, live WorkOS enrollment, public API mount, agent deployment, telemetry transport or payment activation is included.

## Why D13 exists

D12's HTTPS agent client requires an **independently known expected agent ID** before it will write a machine credential to its 0600 vault. The original D9 function allocated the agent ID *during* redemption, preventing a safe fully automated D12 installation.

D13 separates **authenticated human preauthorization** from **one-time machine redemption**:

1. A trusted WorkOS actor with owner/admin membership requests a new Linux agent with fixed hostname, display name, platform and architecture. PostgreSQL independently verifies the actor's organization membership.
2. A new `pending` `monitored_agents` row is created. In the same transaction, a short-lived single-use hashed enrollment token and a tenant-bound binding row are created. The owner-facing control-plane response includes the **preallocated `agentId`**, `enrollmentId`, expiry, organization ID and raw token shown only once.
3. The operator independently conveys the expected organization and preallocated agent IDs over an authenticated control-plane channel, separate from the later machine redemption response. Never copy `expectedAgentId` from the redemption response itself.
4. The D12 HTTPS client uses the one-time token and fixed agent description. The D13 database redemption function locks the token **and pending agent** and only converts the original preallocated agent to active on an exact match. The response must contain the previously authorized `agentId` and organization ID.
5. The D11 vault may then install the credential only when the independently known IDs match and its 0700/0600 filesystem checks pass. This composition remains unmounted and requires further launch approvals.

## Database migration candidate

- Source: `scripts/agent-identity/migrations/0003_preallocated_identity.sql` in a **separate migration directory**. D9 0001, D10 0002 and the historic six administrator SQL scripts are unchanged and separately pinned.
- Requires PostgreSQL `pulse_metrics`, `postgres` DBA and exactly two existing D9/D10 version receipts, six historic privileged receipts, and one original Drizzle ledger entry.
- Adds a composite unique key on the existing enrollment token table to support a **tenant-enforced foreign key**.
- Creates `pulse_agent_enrollment.preallocated_agent_bindings` with both token+organization and agent+organization foreign keys, a unique agent binding, and forced RLS with **no ordinary application role policies**.
- Adds one tightly column-granted **NOLOGIN, NOINHERIT, BYPASSRLS** executor (BYPASSRLS is needed for intentionally policy-free sensitive tables). The executor cannot login, inherit roles, create objects or bypass column grant restrictions.
- Adds distinct `issue_preallocated_enrollment` and `redeem_preallocated_enrollment` SECURITY DEFINER functions with `search_path=pg_catalog,pg_temp`, grants EXECUTE only to `pulse_metrics_app` and no PUBLIC execute.
- **Revokes** ordinary app role EXECUTE on the previous unbound issue/redeem functions. Those old SQL definitions remain unchanged for reproducibility and audit history. Already-issued legacy tokens would need a separate reviewed reconciliation and revocation policy before adoption.
- Inserts the `0003` migration receipt in the same SQL transaction; every permission or schema failure rolls it back.

## Security limitations and operational requirements

- A token's hash, not its raw value, enters PostgreSQL. Raw enrollment tokens and machine credentials cannot be written to logs, URLs, CLI args, shell history or environment variables.
- A pending agent with an expired/revoked/unredeemed token remains pending until a separately reviewed cleanup workflow exists. Do **not** auto-remove or reuse IDs without an explicit retention and audit policy.
- A failed local credential installation **after successful remote redemption** cannot be rolled back atomically across HTTPS and local filesystem. Operator reconciliation, server-side revocation and re-issuance are required.
- The D13 new owner-issued `agentId` is independent of the *redemption response*, but its authenticity still depends on a genuinely verified TLS, WorkOS identity and approved control-plane workflow. Simply copying untrusted JSON is not an independent authorization channel.
- The migration retires only the ordinary app role's old unbound function access; an independently approved production migration must also audit other roles, clients, grants, and revocation of existing tokens.
- A directly privileged PostgreSQL superuser or compromised executor is outside the tenant isolation promise; no database code eliminates that trust boundary.
- Real TLS origin, trusted reverse proxies, rate limiting, credential delivery, recovery, signed agent distribution, authenticated telemetry ingestion and tenant-safe reads are **not** activated here.

## Isolated verification

Run `node --test scripts/agent-identity/verify-candidate.test.mjs`, `node scripts/agent-identity/verify-candidate.mjs` and `node scripts/agent-identity/launch-gate.mjs`, followed by `npm test`, `npm run lint`, `npm run build`, `npm run db:check` and `git diff --check`.

Then run **only** `bash scripts/test-agent-identity-rehearsal.sh` on the reviewed Linux development host. It inherits the D10 guarded disposable Unix-only PostgreSQL harness: checks the local baseline in read-only mode, starts a fresh isolated socket-only cluster, replays the six immutable steps and D9/D10 migrations, proves earlier functionality before changing any grants, then applies the pinned D13 migration and exercises real SQL with two synthetic tenants.

D13 tests must prove denied viewer/foreign-owner preauthorization; one-use token redemption; exact machine detail matching; concurrent redemption exactly once; independent organization binding; legacy unbound EXECUTE retirement; credential revocation; forced RLS; no direct runtime access; and unchanged working-database catalog fingerprint. The cleanup trap must remove the disposable cluster even on failure. A passed rehearsal **does not certify live deployment**.

## Next phase gates

- Signed-off versioned database rollout procedure, backups, rollback, concurrency and old-token adoption review.
- Operator UI or secure authenticated handoff that supplies expected organization and agent IDs and an enrollment token without exposing secrets.
- End-to-end TLS origin verification and real trusted WorkOS owner/admin issuance with distributed quotas.
- Reconciliation of consumed token versus failed local vault write, revocation, expiration and manual recovery.
- Authenticated machine telemetry transport, bounded ingest, tenant-isolated persistence and read APIs, plus operational monitoring and incident response.
