# Pulse Metrics — Phase 2E3C1: invitation acceptance database boundary

**Status:** local development checkpoint; **not** a customer-facing feature or a production migration. This package adds no API endpoint, browser form, email delivery, or verified-email synchronization.

## What this slice adds

`public.accept_organization_invitation(p_subject text, p_token_hash text)` runs as a separate, narrowly privileged `pulse_metrics_acceptance_executor` role. The ordinary `pulse_metrics_app` role gets EXECUTE only, not direct INSERT/UPDATE on organizations or memberships, or direct access to invitation records.

The function:

1. Resolves an existing internal user by `auth_provider='workos'` and the **server-verified** WorkOS subject. Database functions **cannot** authenticate WorkOS sessions on their own.
2. Requires `public.users.email` and a non-null `email_verified_at` no later than the current statement time. Both must be supplied by a **trusted, server-side WorkOS identity synchronization process**; this is **not yet implemented**. No browser-provided email is accepted into the function.
3. Matches the stored verified email to the invitation recipient and matches the token digest to an existing unexpired, unrevoked, unconsumed invitation.
4. Atomically marks the invitation consumed, creates a membership using the invitation's existing role and organization, and writes an `organization.invitation.accepted` audit event.
5. Rejects missing, expired, revoked or already-used invitations; it never assigns `owner` and never updates existing membership roles. A failed membership insertion rolls back consumption and the audit event.

Only the hash of a high-entropy random token goes into PostgreSQL. The future authenticated API must hash a raw token on the server and never accept the digest from the browser as a substitute for the token.

## Critical trust boundaries

`p_subject` is only a shape-validated string at the database layer; it does **not** prove JWT validity. Only a backend route that has verified token signature, issuer, audience, client ID and expiry may supply it. The same applies to the original issuance and organization onboarding functions.

**Do not create the acceptance API until verified email sync is designed and tested**. Today's WorkOS account mapping only stores the subject; it does not populate trusted `email_verified_at`. Importing a browser email or merely taking a claimed `email_verified` boolean without verifying its issuer would defeat the invitation recipient boundary.

`pulse_metrics_acceptance_executor` has `NOLOGIN NOINHERIT BYPASSRLS`, no role memberships and explicit column-limited grants. `BYPASSRLS` is a highly privileged attribute: keep this role isolated; review its grants on every migration. The new function has a fixed search path and fully qualified app objects; no dynamic SQL; PUBLIC execute revoked.

This bootstrap is a separately administered privileged database operation, **not** part of Drizzle's migration ledger. The previously introduced `organization_invitations` table must be reconciled into the schema and reproducible migrations before deploying a fresh environment.

## Local application and tests

Review the SQL before applying:

```bash
less scripts/admin/004_organization_invitation_acceptance.sql
```

Apply **only** to the local `pulse_metrics` database:

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics \
  -f scripts/admin/004_organization_invitation_acceptance.sql
```

Test the restricted runtime role with synthetic users and organizations. The test intentionally creates verified-email synthetic records via local postgres administration; **this is fixture setup, not a production identity-sync method**.

```bash
bash scripts/test-invitation-acceptance-db.sh
npm test
npm run lint
npm run build
npm run db:check
npm run test:integration
```

Test coverage includes recipient mismatch, unverified email, missing/bad subjects, replay, concurrent acceptance, cross-organization binding, existing-membership collision with rollback, expiry, revocation, direct table denial, audit counts and cleanup. The script refuses remote or production database targets and attempts fixture cleanup on exit. Do not run it against production data.

## Pending milestones

- Trusted WorkOS verified-email retrieval and safe update of local users (without trusting browser state).
- Authenticated recipient redemption API, body and token validation, generic errors, rate limiting, redaction, tests.
- Invitation expiration, revocation and resend/rotation lifecycle; delivery with safe URL/token handling.
- Drizzle schema and migration reconciliation; operational readiness and full end-to-end tests.

Old dashboard/SSH routes and WebSockets remain blocked.
