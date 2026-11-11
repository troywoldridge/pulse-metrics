# Pulse Metrics — Phase 2E3C4B4A: trusted proxy client address foundation

**Status: local development and security-test increment. NOT publicly activated.**
**Base commit: `f2527dce6ffc0afebd2d1094222e48a9d08946fb`** on `feat/identity-organization-onboarding`.

## What changes

- Add `src/server/security/trusted-client-address.ts`: an explicit CIDR allowlist for trusted reverse-proxy *socket peers*, IPv4/IPv6 address normalization, and a bounded, right-to-left `X-Forwarded-For` resolver.
- Replace the **entire** `src/server/security/invitation-rate-limit-middleware.ts` with an extended version supporting the existing `local-direct-socket` mode and a new `trusted-proxy` mode in local development. The actor guard still runs only after the verified WorkOS bearer middleware.
- Add two unit-test modules, a guarded real HTTP/PostgreSQL integration test and security documentation.
- **Do not modify `server.ts`, database roles, SQL migrations, configuration files or deployment routing.** Invitation acceptance remains unmounted. `NODE_ENV=production` still intentionally returns `503` for invitation operations; no mode can override the production block in this increment.

## Trust algorithm and security invariants

1. `req.socket.remoteAddress` must be a real IP belonging to the explicitly configured trusted proxy CIDR list. Untrusted direct peers cannot supply forwarding headers, even if they contain plausible client addresses.
2. Exactly one `X-Forwarded-For` request-header field must be present. Empty, invalid, overly long, duplicated and oversized chains are denied. The RFC `Forwarded` and `X-Real-IP` fields are **not** used as authority.
3. The resolver reads the chain from right to left and returns the **nearest untrusted hop**. The leftmost user-injected addresses are disregarded. If all hops are trusted or malformed, fail closed with a generic `503`.
4. Canonicalize IPv6 addresses, including hexadecimal IPv4-mapped spellings, before constructing the HMAC-derived network bucket. Otherwise alternate textual representations could evade limits.
5. Failed trust or storage checks block the invitation before authorization or business logic. Valid requests keep the order: network quota → verified bearer → actor quota → invitation operation. HTTP `429` retains a bounded Retry-After header.
6. Only explicit CIDRs are allowed. No hostnames, `/0` networks, mixed IPv4-mapped CIDRs, duplicate entries or unspecified trust list. The implementation accepts up to 32 comma-separated entries.

## The *required* ingress contract

This resolver is safe only if the **last trusted ingress proxy appends its observed TCP peer address**, or replaces XFF with an independently verified client address. If a proxy merely passes through a caller-supplied XFF header, **an attacker can spoof their IP**. The application cannot repair a broken ingress trust chain.

For a direct browser → Nginx → Express topology on one machine, Nginx should overwrite client-provided XFF using its observed peer:

```nginx
# Illustrative header behavior, NOT a complete deployable Nginx config.
proxy_set_header X-Forwarded-For $remote_addr;
proxy_pass http://127.0.0.1:3000;
```

The app should listen only on loopback (or a separately secured private channel) so internet clients **cannot connect to Express directly**. Confirm the actual listener address, firewall policy, and proxy chain; never infer them from the presence of an Nginx config file.

For Cloudflare → Nginx → Express, `$remote_addr` is usually the Cloudflare connecting proxy address unless Nginx is explicitly configured to accept the real client IP from **verified Cloudflare source ranges**. Only use Cloudflare-specific headers after (1) restricting direct origin access, (2) validating and maintaining Cloudflare source ranges, and (3) auditing the actual Nginx real-IP module and the generated XFF header. Do not add arbitrary Cloudflare or RFC1918 networks to the Express trusted-proxy CIDR list. Prefer keeping the immediate Express peer to an explicit loopback `/32` or `/128` and handling upstream trust entirely at the Nginx layer. The current increment does not ship an unverified Cloudflare or Nginx deployment configuration.

**Do not enable** Express `trust proxy` globally to compensate for missing trust information. This implementation intentionally ignores `req.ip`, `X-Real-IP` and RFC `Forwarded` for rate-limit identity.

## Configuration (development only)

`createLiveInvitationRateLimitGuards()` recognizes:

- `INVITATION_RATE_LIMIT_NETWORK_MODE=trusted-proxy`
- `INVITATION_TRUSTED_PROXY_CIDRS=127.0.0.1/32` for a *verified local* Nginx → Express socket peer; additional exact CIDRs must be reviewed separately
- `INVITATION_RATE_LIMIT_HMAC_KEY`: the existing random, server-only, 32-byte base64url key

The current local `local-direct-socket` mode remains available for direct local Express tests. Unknown or missing modes, missing or invalid CIDRs, missing HMAC key, and all **production-mode** configurations still fail closed with `503`. Do not copy these development settings into an internet-facing environment until the production activation gate is reviewed. Do not put HMAC keys in `VITE_` variables or Git.

## Verification

```bash
cd ~/Projects/pulse-metrics
set +e
npm test
npm run lint
npm run build
npm run db:check
bash scripts/test-invitation-trusted-proxy-http-db.sh
bash scripts/test-invitation-route-rate-limit-http-db.sh
npm run test:integration
```

The new database-backed wrapper binds only to 127.0.0.1, verifies the local `pulse_metrics_app` role, uses synthetic bearer verification and synthetic issuance, and generates a random HMAC secret and subject. It confirms two independent client-IP buckets (even when requests share one proxy socket IP), actor quotas, forged-left-chain resistance, and IPv6 normalization using real PostgreSQL counters. The wrapper audits actual counts through the local administrator and deletes only the four generated HMAC digests on exit. It cannot prove the deployed proxy sanitizes headers or that live WorkOS works.

## Remaining activation gates

- Inspect and verify the **real** Nginx/Cloudflare routing chain, origin firewall, binding and proxy append/overwrite behavior using safe local tests.
- Verify live WorkOS JWT and Management API with server-only credentials, plus account change and session revocation behavior.
- Reconcile privileged bootstrap SQL (001–006), invitation data and RLS policies with reproducible, audited migrations and deployment safety checks.
- Operate edge request-flood controls, counter retention, privacy and monitoring, and test fairness for shared-NAT customers.
- Review invitation delivery, CSRF/origin behavior, authorization, onboarding UX, and enable acceptance in a distinct, reviewed activation milestone.
- Remove disabled legacy simulated metrics / SSH code and complete real agent enrollment before customer launch. Do not enable legacy WebSockets.

Passing these tests is **not** authorization to deploy the app publicly.
