# Pulse Metrics — Phase 2E3C2: trusted WorkOS email evidence adapter

**Status:** local-only, read-only preparation. Not a complete identity sync, not a
customer-facing acceptance endpoint, and not a production deployment milestone.

## What is added

`src/server/auth/workos-verified-email.ts` provides an injectable, server-only
reader for a freshly fetched WorkOS User Management record. It requires the
caller to use an `AuthenticatedIdentity` produced by `requireWorkOSUser()` after
verifying the user's bearer token. The adapter requests the WorkOS user by the
verified `sub`, checks that the returned `id` matches, requires the actual
boolean `emailVerified === true`, validates the email and normalizes its case.
An explicitly unverified email returns `null`; malformed or unavailable evidence
throws a sanitized error. No browser-provided email, JWT email claim, profile
object, or verification boolean may be substituted for this check.

Live user lookup uses `workos.userManagement.getUser(subject)` through a
server-only WorkOS SDK client, which requires `WORKOS_API_KEY`. The server should
set this secret in its private environment or `.env.local`, not in client code
and never in a `VITE_` variable. Do **not** paste this key into chat, logs, Git,
or test fixtures. No key is needed for unit tests because the WorkOS API call is
injected as a stub. This package does not edit any `.env` file.

## Security boundaries and remaining work

This module is deliberately **not mounted in server.ts**, and does not call any
SQL or modify `users.email` or `users.email_verified_at`. It does not create,
accept, revoke or email invitations. It cannot grant organization membership.

The next step needs a separately reviewed privileged database synchronization
function, with minimal column-level grants. Refresh the WorkOS profile before
each acceptance attempt: a previously verified, cached email must not be trusted
indefinitely after a WorkOS email change or verification revocation. Implement
an atomic synchronization-and-acceptance approach or an equivalent design with
an explicit freshness/concurrency guarantee, then test failures, repeated calls,
revocations and email changes against real PostgreSQL.

PostgreSQL `email_verified_at` is an internal attestation timestamp, not a value
supplied by a browser; never set it merely because a user has authenticated.
An unverified account must not gain access to a pending invitation.

WorkOS's User Management API responds with `email_verified`. In the Node SDK,
this is available as `emailVerified`. A WorkOS management API key is required
for `getUser`; public-client authentication without a secret is insufficient.

Official references:
- https://workos.com/docs/reference/authkit/user
- https://workos.com/docs/sdks/node

## How to verify

```bash
cd ~/Projects/pulse-metrics
npm test
npm run lint
npm run build
npm run db:check
git diff --check
git status --short
```

No migration or database setup is needed. Keep invitation redemption disabled
and do not deploy this read-only component to public customers as a claim of
complete verified-recipient support.
