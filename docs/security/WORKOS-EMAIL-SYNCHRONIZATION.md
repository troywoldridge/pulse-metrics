# Pulse Metrics — Phase 2E3C3: verified WorkOS email synchronization

**Status:** LOCAL DEVELOPMENT, not public-facing, no invitation redemption API.
**Base commit:** `7a14179` (`feat/identity-organization-onboarding`).

## Trust model

Existing `src/server/auth/workos-verified-email.ts` fetches the WorkOS
User Management profile using a **server-only** API key. It requires that the
returned WorkOS user ID match the subject from a previously validated WorkOS
bearer token. Only a real boolean `emailVerified === true` makes the email
eligible for storage as verified. A provider record explicitly reporting
unverified yields `null`. An outage or malformed response throws an error.

`src/server/auth/workos-email-sync-service.ts` introduces a **server-only**
composition: validate the verified identity, fetch a fresh WorkOS record,
provision/resolve that subject's internal UUID, and invoke the restricted
PostgreSQL synchronization function. The email is **never read from the
browser, JWT email claim, or a route request body**. This module is NOT
mounted in `server.ts` and cannot be called through a new HTTP endpoint.

## Database boundary

`005_workos_verified_email_sync.sql` creates
`public.sync_workos_verified_email(p_subject text, p_verified_email text)`.
Its owner, `pulse_metrics_email_sync_executor`, is `NOLOGIN NOINHERIT
BYPASSRLS`, has no role memberships, and is granted `SELECT` of user identity
columns plus `UPDATE` of **only** `users.email`, `users.email_verified_at`,
and `users.updated_at`. It gets no membership, invitation or audit writes.
The normal runtime role receives only `EXECUTE`, no direct user UPDATE.
PUBLIC execute is revoked. The function updates only **existing** WorkOS
identities and returns only the internal UUID.

- A verified email is normalized and stored with the time the server asserted
  fresh WorkOS verification.
- An **explicitly unverified** WorkOS response passes SQL NULL, which clears
  both stored email and `email_verified_at` to prevent stale acceptance.
- A changed verified email replaces the old one, and updates the attestation
  timestamp. A different email cannot match an old invitation.
- Provider outage, malformed user data, or missing API key causes an error
  **without** the service writing a replacement/cached email.
- A missing existing internal user yields SQLSTATE `P0002`; malformed subject
  or email yields `22023`. Never expose those details in public responses.

**Security limitation:** PostgreSQL cannot cryptographically verify WorkOS
sessions or management API responses. A caller with application database
credentials can invoke this fixed function with a chosen subject and email;
therefore the runtime credentials are privileged application secrets, and the
function must only be called by the trusted backend path after provider
verification. Do not expose this function via direct client SQL or a generic
HTTP wrapper. A future invitation-redemption API MUST perform a **fresh**
WorkOS fetch before every acceptance attempt. On provider outage, deny
redemption rather than trusting previously stored verification. Review the
synchronization-and-acceptance concurrency window before exposing customer
redemption; preferably implement a single transaction with explicit freshness
attestation and appropriate locking semantics.

## Applying to the local developer database

Review the complete SQL. Apply **once**, and only to the local `pulse_metrics`
database, using `sudo -u postgres`; the SQL guard rejects overwriting an
existing function. Do not reapply 001–004, drop the database, or alter any
existing PostgreSQL permissions manually.

```bash
less scripts/admin/005_workos_verified_email_sync.sql
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics \
  -f scripts/admin/005_workos_verified_email_sync.sql
```

Then test:

```bash
bash scripts/test-workos-email-sync-db.sh
npm test
npm run lint
npm run build
npm run db:check
npm run test:integration
```

The test script refuses remote/production connections, uses the restricted
`pulse_metrics_app` role for function calls, creates synthetic users and one
synthetic organization, and removes fixtures on exit (or reports cleanup
failure). It exercises rejection before syncing verification, verified
acceptance and replay denial, explicit unverified state, changed-email
behavior, permissions, and audit counts. WorkOS responses in unit tests are
**synthetic**; no real WorkOS key is needed, and no provider API request is made.

## Not yet finished

- Live WorkOS API verification with the real server-only key in a controlled
  environment (no key sharing or logging).
- Authenticated, rate-limited one-time invitation acceptance route with robust
  provider-freshness, replay, timing and error-handling tests.
- Invitation email delivery, lifecycle and administration.
- Reproducible production schema/privilege bootstrap and Drizzle reconciliation.
- Removal of prototype simulation/SSH paths, secure WebSockets, agent
  enrollment and actual telemetry ingestion.

Keep all legacy monitoring APIs and WebSockets disabled.
