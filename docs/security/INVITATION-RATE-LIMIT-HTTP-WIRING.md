# Pulse Metrics — Phase 2E3C4B3: HTTP invitation rate-limit wiring

**Status: local-only hardening. Not a production-ready invitation flow.**
**Required base commit:** `d0861905a41284153fd0722b8e854e276f04b1a6`.

## Scope

The single existing live issuance route is now guarded by two *separate*
Express middleware stages:

1. `invitationRateLimits.network('issue')` before `requireWorkOSUser()`.
2. `requireWorkOSUser()` validates the WorkOS bearer.
3. `invitationRateLimits.actor('issue')` using `res.locals.authenticatedIdentity`.
4. `createInvitationIssuanceRoute()` performs existing authorization/issuance.

The tested `network('accept')` and `actor('accept')` guards are also available,
but `POST /api/invitations/accept` is STILL NOT MOUNTED in `server.ts`.
A separate test-only Express app simulates both issuance and acceptance with
synthetic bearer validation and stubbed business operations, but uses REAL
PostgreSQL rate-limit counters through the restricted runtime database role.
Do not mistake this for live WorkOS integration or public acceptance activation.

`server.ts` is rewritten end to end by the guarded installer after checking
an exact Git baseline and confirming the two expected server anchors.
The rest of the file is preserved verbatim; existing disabled WebSocket upgrades,
prototype SSH/telemetry pathways and fail-closed legacy APIs remain untouched.
The installer does not change any `.env`, PostgreSQL role or SQL function.

## Fail-closed configuration

The default is to deny invitation issuance with `503` rather than permit an
unlimited route. This happens if either the HMAC key is absent/invalid, the
network mode is unspecified, or the application is in `NODE_ENV=production`.
Other authenticated application APIs and `/api/health` are unaffected.

**Local development only**, when directly connecting to Express rather than
through a reverse proxy, the private server environment may define:

- `INVITATION_RATE_LIMIT_HMAC_KEY`: canonical 32-byte base64url key. Generate
  with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`
  and save only in private secret storage / an ignored server-side `.env` file.
  Never put the key in `VITE_`, logs, chat, browser code, or Git.
- `INVITATION_RATE_LIMIT_NETWORK_MODE=local-direct-socket`.

The local test suite generates its own ephemeral secret and does not require
setting either variable. **Do not use `local-direct-socket` for public traffic.**

`req.socket.remoteAddress` comes from the network socket, not a browser header.
When Nginx/Cloudflare fronts Express, it is normally the proxy IP, so all
customers could share one quota. This phase does not implement a trusted proxy
resolver. An explicit production-mode guard blocks even
`local-direct-socket` in `NODE_ENV=production` until a rigorously specified
proxy-to-edge trust policy is deployed and tested. Neither `X-Forwarded-For`
nor `X-Real-IP` is trusted, nor is Express `req.ip` used.

A denied bucket returns `429`, a bounded `Retry-After`, `no-store`, and a
generic error; a storage/secret/trust-policy failure returns `503` and fails
closed. Tokens and email addresses are not used in rate-limit keys. Each
network request consumes quota even if the bearer is invalid. Verified actors
consume quota even on later business validation failure. If storage is down,
the invitation operation is not called.

## Local verification

```bash
cd ~/Projects/pulse-metrics
set +e
bash scripts/test-invitation-route-rate-limit-http-db.sh
npm test
npm run lint
npm run build
npm run db:check
npm run test:integration
bash scripts/test-invitation-rate-limit-db.sh
bash scripts/test-invitation-acceptance-http-db.sh
```

The guarded HTTP/Postgres script checks local `pulse_metrics_app`, local
`pulse_metrics` DB, and non-production mode. A fresh random HMAC key and
synthetic subject IDs isolate its counters; cleanup deletes only the four
known synthetic digest keys after success or failure. It uses `sudo -u postgres`
for verification and cleanup, never for customer data.

Expected real HTTP/Postgres tests cover: network quota before authentication;
10 permitted issuance actor attempts then denial; 60 permitted network issuance
attempts then denial even with forged forwarded headers; 20 permitted
redemption actor attempts then denial; state verification and cleanup.

## Not yet complete

- Trusted ingress/client-IP mapping for a multi-proxy deployment and edge WAF.
- Live WorkOS account verification with private SDK credentials and session
  lifecycle testing.
- Production reproducible migrations for privileged SQL and new tables.
- Operational monitoring, retention/cleanup jobs, abuse detection, NAT fairness.
- Production acceptance route activation, secure delivery, CSRF/origin review.
- Agent enrollment, authenticated telemetry ingestion, and authorized WebSockets.

The historical dashboard's mock data and SSH code must remain inaccessible.
Never interpret passing local tests as permission to expose Pulse Metrics publicly.
