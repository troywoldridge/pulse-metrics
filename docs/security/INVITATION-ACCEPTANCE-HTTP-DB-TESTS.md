# Pulse Metrics — Phase 2E3C4B1: HTTP-to-PostgreSQL acceptance verification

**Status: local-only test increment; NOT a production endpoint.**
**Base Git commit:** `c3a756bf4dc891a79b9930eff85761b270c7c7af` on `feat/identity-organization-onboarding`.

## Purpose

Phase 2E3C4A introduced an authenticated invitation acceptance route and a
transactional PostgreSQL adapter, but deliberately did not mount the route in
`server.ts`. This increment verifies the actual *HTTP -> route -> service ->
restricted PostgreSQL* call chain using the existing implementation.

Two synthetic local organizations, five synthetic identities and temporary
invitation tokens are created and removed by the test wrapper. The HTTP test
binds only `127.0.0.1` on an ephemeral port. It deliberately uses a **synthetic
bearer-token verifier and synthetic WorkOS profile fetcher**; it does not access
the live WorkOS Management API or require a WorkOS API key. This is NOT proof
that the live WorkOS integration has been configured or verified.

The test covers these invariants:

- Missing/invalid bearer token is rejected before provider lookup or redemption.
- Non-JSON requests, token hash substitution and browser-provided email, role,
  subject, organization or digest overrides are rejected.
- Invalid, unknown, expired, mismatched and consumed invitations must not reveal
  membership or recipient details. This test directly exercises unknown,
  mismatched and consumed cases; expiry/revocation are covered by the separate
  PostgreSQL test in Phase 2E3C1.
- The verified recipient's changed email is synchronized, then the old-email
  invitation is rejected. Explicitly unverified email clears verification.
- WorkOS profile-fetch outage returns a sanitized 503 without redemption.
- Valid acceptance returns only the organization UUID and non-owner role.
- One-time acceptance, membership collisions and two concurrent requests
  cannot create additional memberships or promote users.
- A local PostgreSQL administrator verifies final table state: three
  invitations, exactly two consumed, two acceptance audit events and exactly
  four memberships (two preexisting owners, two accepted viewers) across
  the test organizations; outsider is not a member.

## How to run

**Use only on Troy's local development database**, never against customer
records or a remote PostgreSQL host. The wrapper validates `.env` database
connection and demands `pulse_metrics_app@localhost/127.0.0.1/::1`, database
`pulse_metrics`, and nonproduction mode. It uses local sudo PostgreSQL admin
access for synthetic fixture setup, final read-only verification and cleanup.

```bash
cd ~/Projects/pulse-metrics
set +e
bash scripts/test-invitation-acceptance-http-db.sh
HTTP_RESULT=$?

npm test
UNIT_RESULT=$?
npm run lint
LINT_RESULT=$?
npm run build
BUILD_RESULT=$?
npm run db:check
DB_RESULT=$?

echo "HTTP/PostgreSQL: $HTTP_RESULT"
echo "Unit tests: $UNIT_RESULT"
echo "TypeScript: $LINT_RESULT"
echo "Build: $BUILD_RESULT"
echo "Drizzle check: $DB_RESULT"

git status --short
```

The wrapper attempts cleanup on success or failure. Do not paste real access
tokens, WorkOS API keys or database connection passwords into output logs.
If a cleanup error occurs, investigate only the `pulse-http-redeem-` synthetic
fixtures before rerunning anything.

## Security restrictions and unresolved work

- **Do not mount** `createInvitationAcceptanceRoute()` in `server.ts` yet.
- There is NO rate limiter in this increment. Customer activation requires an
  abuse-resistant shared rate limiter that applies across horizontally scaled
  API processes, both on issuance and redemption. Use stable user/network
  identifiers (not raw invitation secrets) and control proxy trust explicitly.
- Live WorkOS Management API verification, SDK credentials, session lifecycle
  and end-to-end request security must be tested separately before launch.
- Current acceptance SQL relies on its trusted backend and restricted DB role:
  SQL alone cannot cryptographically validate WorkOS identity. Runtime database
  credentials must remain secret, and SQL injection must be prevented in all paths.
- Invitation table and privileged bootstrap SQL are not yet represented by a
  fully repeatable fresh-install migration path. `drizzle-kit check` alone does
  not demonstrate migration parity.
- No email delivery, customer invitation management or onboarding UI is added.
- Legacy fabricated dashboard readings, arbitrary SSH actions and WebSocket
  upgrades remain disabled for production use.

A passing test only supports the scenarios actually exercised; it is not
production readiness certification.
