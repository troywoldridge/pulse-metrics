# Pulse Metrics — Phase 2E3B invitation issuance API

Status: **local development only**. Not ready for public customer use.

## Contract

`POST /api/organizations/:organizationId/invitations`

- Requires a server-verified WorkOS bearer via the existing `/api` middleware.
- Request JSON **only**: `{ "email": "recipient@example.com", "role": "member" }`.
- Roles: `admin`, `member`, `viewer`. `owner` is never assignable by invitation.
- Organization UUID is a route parameter; it is not trusted to convey access.
- Runtime derives issuer from the verified bearer. The caller cannot supply `userId`, issuer subject, token hash, expiration or actor role.
- Database security-definer function `public.issue_organization_invitation()` independently authorizes:
  - owner may invite admin/member/viewer;
  - admin may invite member/viewer;
  - member/viewer/unaffiliated accounts cannot issue invitations.
- Only a SHA-256 digest of a fresh 32-byte CSPRNG token is stored. An authorized issuer receives the raw secret **once** in the response as `oneTimeToken` for future delivery. Never log it or store it in localStorage.
- Fixed 24-hour expiration; server does not accept user-supplied expiration.
- Result has `Cache-Control: no-store`. 201 on success, 401 missing/invalid bearer, 400 bad input, 415 non-JSON, 403 no permission, 503 backend failure. Diagnostic text is never returned.
- No email is sent. No invitation can be redeemed in this phase. Do **not** send the token to anyone yet. When delivery is implemented, decide whether copy-link mode or a dedicated transactional email workflow should own token exposure.

## Incomplete production requirements

- The runtime-issued raw secret is available once and cannot be recovered from PostgreSQL. If lost, the pending invitation will need a reviewed revocation/reissue workflow.
- Add per-organization and per-issuer abuse/rate limits, idempotency/retries, invitation listing, revocation, spam defenses and monitoring before any public deployment.
- Build a secure redemption function with **verified recipient email**, single-use locking, expiration and revocation checks, audit events and duplicate membership controls. WorkOS subject alone does not prove ownership of the invited email address.
- Add email delivery with replay-safe retry logic before enabling recipient-facing flows.
- `organization_invitations` was created via privileged bootstrap 003 and is **not yet represented in the canonical Drizzle schema/migration history**. `drizzle-kit check` alone does not validate this gap. Reconcile before using automated fresh-database deployments.
- Maintain the current fail-closed prototype dashboard and WebSocket controls.

## Testing

Run `npm test`, `npm run lint`, `npm run build`, `npm run db:check`, `bash scripts/test-invitation-issuance-db.sh`, `npm run test:integration` and `git diff --check` before committing. The invitation route tests use injected services for HTTP/role/error behavior. Database authorization is separately tested by `scripts/test-invitation-issuance-db.sh`. A live Express-to-PostgreSQL test of the full issuance endpoint is a follow-up verification before treating the slice as completed.

## Security boundary

This endpoint is **not** a membership API. It cannot read invitation secrets from the database, accept or revoke an invitation, or insert memberships. Keep those permissions separate. Never grant direct `INSERT`, `UPDATE`, `SELECT` or `DELETE` on `public.organization_invitations` to `pulse_metrics_app`.
