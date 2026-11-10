# Pulse Metrics — Phase 2E3C4B2: shared invitation rate limiting

**Status: local development foundation; NOT mounted in Express.**
**Base Git commit:** `8f34478a7968c257fd69f56a4335a97fbe34e683` on `feat/identity-organization-onboarding`.

## Intent and threat model

The invitation issuance route is already authenticated. The acceptance route is tested but intentionally unmounted. Neither route should be exposed to public customers without shared abuse protection. Per-process in-memory counters would not protect a multi-instance deployment.

The new `public.invitation_rate_limits` table stores only HMAC-SHA256 bucket digests, never raw client IPs, WorkOS subject IDs, email addresses, access tokens or invitation secrets. Its owner is `pulse_metrics_migrator`. FORCE RLS is enabled with **no policies**, and `pulse_metrics_app` has **no direct table permissions**.

A dedicated `pulse_metrics_rate_limit_executor` role owns one fixed `SECURITY DEFINER` function. The executor is NOLOGIN, NOINHERIT, BYPASSRLS, has no role memberships, and is granted only access to the new table's columns. The runtime role can EXECUTE `public.consume_invitation_rate_limit(text,text,text)` but cannot directly read, delete or reset counters. The function has a fixed search path and contains no dynamic SQL.

### Fixed quotas

| Action | Bucket | Allowed within a fixed 15-minute window |
|---|---|---:|
| issue | verified actor | 10 |
| issue | client network address | 60 |
| accept | verified actor | 20 |
| accept | client network address | 120 |

The next request is denied until the window expires, and its attempt still increments the counter. These are provisional engineering quotas, **not calibrated production limits**. An atomic INSERT/ON CONFLICT UPDATE locks the bucket and prevents concurrent requests across multiple app processes from bypassing the quota. A denied call returns a positive retry-after seconds value capped by the 15-minute window.

### Integration requirements (intentionally pending)

1. Determine a **trusted client IP** at the ingress boundary. `req.socket.remoteAddress` is safe from a spoofed `X-Forwarded-For` header but sees the proxy's IP when behind Nginx/Cloudflare. Do not silently trust arbitrary forwarded headers or mount this limiter until the forwarding chain and expected proxy IPs are explicitly configured and tested. If an IP is not trustworthy, deny the request rather than using a user-controlled IP.
2. Check the **network** bucket before expensive JWT verification and WorkOS calls. Check the **actor** bucket after signature, issuer, audience and expiration have been verified. Both are required for each relevant request. A successful request also consumes quota; do not rate-limit only errors.
3. Generate one random 32-byte HMAC key (`node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`) on the server. Store it as `INVITATION_RATE_LIMIT_HMAC_KEY` in server-only secret management. **All app instances must use the same key**; never store it in Git, `VITE_` variables, logs or browser code. Do not set up the secret until endpoint wiring is ready. Rotating the key resets effective user/network buckets, so coordinate key rotation carefully.
4. On limit denial, return **429** with a bounded `Retry-After` header and a generic error. On database/network/key failure, **fail closed** (503), never continue to issuance/redemption. Use `Cache-Control: no-store` and avoid logging raw tokens, bearer credentials, or raw keys.
5. Use an upstream WAF / edge per-IP flood defense as well; a database function alone cannot defend against massive unauthenticated connection floods or many distinct spoofed identities. Consider shared-NAT effects and fairness across organizations before public launch.
6. Add a reviewed counter-retention job (only the database administrator/migrator should delete expired rows); do not grant arbitrary runtime DELETE. For example, a future maintenance task may remove rows with `window_end < now() - interval '2 days'` after ensuring metrics and monitoring are in place. Index on `window_end` supports this.
7. Verify live WorkOS management API behavior, complete route wiring and complete replay/abuse tests. The acceptance endpoint remains **unmounted**, and the current issuance endpoint is **not yet rate limited**. Keep the entire app private until the protections are fully wired.
8. Reconcile this table and the earlier invitation table/admin bootstrap scripts with reviewed, repeatable Drizzle migrations before production. `drizzle-kit check` alone is not live schema parity.

## Local installation and verification

Review SQL before applying:

```bash
cd ~/Projects/pulse-metrics
less scripts/admin/006_invitation_rate_limits.sql
```

Then use **input redirection** so the `postgres` OS account does not need read access to Troy's home directory:

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics \
  < scripts/admin/006_invitation_rate_limits.sql
```

Run the guarded test. It refuses nonlocal or production database targets and uses only randomly named synthetic rate-limit digests; the cleanup trap deletes only these digests:

```bash
bash scripts/test-invitation-rate-limit-db.sh
npm test
npm run lint
npm run build
npm run db:check
npm run test:integration
```

The test exercises the restricted runtime role, all four quotas, key isolation, concurrent requests from a multi-connection pool, malformed input rejection, direct-table denial, simulated window expiry, and fixture cleanup. Mocked TypeScript unit tests verify HMAC derivation, request identity validation and fail-closed error handling. No live WorkOS API key is used.

**Do not reapply the SQL bootstrap if it reports objects already installed.** This script intentionally refuses replacement. Do not modify the current secure invitation route or WebSocket lockdown while installing this test-only package.
