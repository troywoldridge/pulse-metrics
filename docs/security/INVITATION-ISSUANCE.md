# Pulse Metrics — Phase 2E3A: Invitation issuance database foundation

**Status:** local-only, pending live PostgreSQL integration test; not an email or membership workflow.

## Scope and design

This slice adds `public.organization_invitations` and a single `public.issue_organization_invitation(text,uuid,text,text,text,timestamptz)` function. **It does not add a route, send email, generate invitation secrets, redeem an invitation, grant membership or change an existing role.** The earlier owner/admin roster endpoint continues to work unchanged.

The table is migration-role-owned, `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, with **no policies** and **no direct grants** for `pulse_metrics_app`. A dedicated `pulse_metrics_invitation_executor` role owns a `SECURITY DEFINER` function; it has `NOLOGIN NOINHERIT BYPASSRLS`, zero memberships and only the column-level grants needed for the issuance operation. BYPASSRLS is intrinsically powerful: audit the role, function, grants and ownership carefully. Never give this role LOGIN or memberships.

The function requires an existing WorkOS subject mapped to an internal user UUID and verifies an *existing* organization membership and allowed role. Owners may invite `admin`, `member`, `viewer`; admins may invite `member`, `viewer`; members and viewers cannot invite. `owner` cannot be assigned by invitation. Permission checks and invitation + `organization.invitation.created` audit insert are atomic. The audit metadata only carries the invited role, not email or token.

The API that will call the function **must** verify the WorkOS bearer independently and derive `p_subject` from that verification. The database function cannot verify a JWT or independently know whether the caller supplied a spoofed subject; existing `pulse_metrics_app` DB credentials are therefore privileged application secrets. It must never take `p_subject` from a browser body. The API must also enforce CSRF/origin considerations appropriate to its credential scheme, rate limiting, invitation quotas and email-delivery abuse prevention.

The function takes only a **SHA-256 hex digest of a cryptographically random, 32-byte or longer invitation secret**, never the plaintext token. The future API must use a cryptographically secure random generator and deliver the plaintext only via an appropriately protected channel. Hashing user passwords, JWTs or predictable strings would be unsafe. The current test uses random digests but **does not send any invitations**. Tokens expire between 5 minutes and 7 days from issuance.

`invited_email` stores a normalized lowercase email address. This is sensitive personal data; minimize log exposure and define retention/cleanup. Initial validation is deliberately restricted to common ASCII email address forms; internationalized addresses and email-equivalence semantics need deliberate product design before general availability.

## Redemption requirements (NOT IMPLEMENTED)

A later phase must independently verify the recipient's email through trusted WorkOS user-management data—not untrusted browser input or an unverified JWT field—and compare it to the intended invitee. Acceptance must atomically lock and consume an unexpired, unrevoked, unused token and insert membership exactly once, with audit records and concurrency tests. The raw token must never be logged or stored. Invitations must not silently merge accounts. Role administration and last-owner safeguards are separate changes.

## Migration warning

**This is a manual, local development bootstrap.** It creates a database table before adding a corresponding Drizzle schema definition or migration metadata. `npm run db:check` does not prove the live database matches Drizzle's snapshot. Before production, reconcile the invitation table with `src/db/schema.ts`, a repeatable migration and permissions provisioning, and validate fresh DB installation. Do not use Drizzle `push` or schema resets to "fix" drift; do not apply to a hosted database yet.

## Installation and verification

1. Install three new files using the guarded installer.
2. Read the SQL carefully.
3. Apply to the local PostgreSQL development database only:

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics -f scripts/admin/003_organization_invitations.sql
```

4. Run the temporary-fixture test against `pulse_metrics_app`:

```bash
bash scripts/test-invitation-issuance-db.sh
npm test
npm run lint
npm run db:check
npm run test:integration
```

The test creates two synthetic organizations and several user roles, asserts allowed/denied invitation issuance, tests direct access denial, audits hashes and events, and then removes **only its own synthetic rows**. It does not modify the actual customer organization's membership.

Do not commit until the live database tests and Git review pass. Do not expose the issuing function via HTTP yet.
