# Pulse Metrics — Phase 2E3C4A: authenticated acceptance API foundation

**Status: unmounted, development only.** Tested source and route skeleton; NOT a customer-facing endpoint and NOT production-ready. Base commit: `cc113cb` on `feat/identity-organization-onboarding`.

## Scope

This package adds:

- `src/server/auth/invitation-acceptance-service.ts`: validates WorkOS identity shape and a canonical 32-byte random invitation token, gets **fresh** verified email through the server-only WorkOS Management API, hashes the raw secret with SHA-256, and invokes a single transactional PostgreSQL adapter.
- `src/server/auth/invitation-acceptance-route.ts`: an **unmounted** `POST /api/invitations/accept` handler with strict `{ "token": "<raw-secret>" }` input, generic denial for invalid/expired/mismatched/used invitations, no-store responses, and sanitized outages.
- Separate service and Express route unit tests, and an actual PostgreSQL transaction integration test using `pulse_metrics_app`, synthetic users and deterministic cleanup.

No `server.ts` modification; no new WorkOS configuration or privileges. No email delivery or new SQL migration. The existing `001`–`005` SQL functions must already have been installed locally, as tested in the previous phases.

## Why one database transaction matters

The PostgreSQL adapter runs `resolve_workos_user`, `sync_workos_verified_email` and `accept_organization_invitation` in a **single Drizzle transaction**, on one connection. The synchronization `UPDATE` holds a row lock through acceptance, preventing a concurrent synchronization from changing the stored verified email between those operations. WorkOS evidence is freshly fetched **before** that transaction; a provider change in that small interval is still possible and must be handled operationally with sensible session lifetime, revocation and audit monitoring.

The acceptance function runs in a **nested transaction (SAVEPOINT)**. If a token is unknown/expired/used/mismatched (`P0002`) or the recipient is already a member (`23505`), only the attempted acceptance rolls back. The verified-email update still commits, so changed/unverified evidence cannot remain stale just because redemption was denied. Unexpected database errors roll back the entire transaction and return a generic service failure.

With an explicitly unverified WorkOS account, the synchronization writes `NULL`, clears email verification, and skips acceptance. On WorkOS API failure there is **no DB operation** and no fallback to cached email. The request must derive subject only from verified WorkOS JWT middleware; a browser cannot supply subject, email, role, organization or token hash.

**Database trust limitation:** the database functions do not cryptographically authenticate the caller's WorkOS identity/email and can be invoked by `pulse_metrics_app`. This is a trusted-backend boundary, not a defense against compromise of the application runtime role itself. Keep runtime credentials private and avoid untrusted SQL execution in any app path.

## Test commands

```bash
cd ~/Projects/pulse-metrics
set +e
npm test
npm run lint
npm run build
npm run db:check
npm run test:integration
bash scripts/test-invitation-acceptance-transaction-db.sh
```

The database script refuses non-local, non-`pulse_metrics`, non-runtime-role, or production targets. It uses synthetic subjects and a random slug, runs real PostgreSQL checks through the restricted application role, then deletes fixtures through an exit trap. It requires sudo's normal local administrator privileges. Do not run against production or copy secrets into a transcript.

## Before mounting the route in server.ts

1. Add per-identity/IP, low-cardinality global, and per-invitation abuse prevention; avoid raw token in rate-limit keys and logs. Keep failed and successful requests bounded. Handle reverse proxy headers carefully.
2. Run a live integration test with WorkOS's management API using a **server-only** key. Never expose the key in `VITE_` or commit it.
3. Add actual Express + PostgreSQL end-to-end tests, including request boundaries, replay and concurrency.
4. Review CSRF/origin implications of the chosen auth approach, and logs, metrics, and token handling.
5. Reconcile the invitation table and privileged SQL bootstrap scripts with a reproducible, reviewed migration process. `drizzle-kit check` alone does not verify live schema parity.
6. Re-review issuance endpoint exposure and rate limiting before enabling either endpoint for public customers.

Existing dashboard, legacy SSH and WebSocket endpoints remain restricted. This module is deliberately **not imported by `server.ts`** until the remaining controls are in place.
