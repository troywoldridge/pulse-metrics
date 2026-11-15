# Pulse Metrics — D15C-5R isolated outbound telemetry sender

**Status:** Offline-reviewed candidate only. **PUBLIC LAUNCH: NO_GO.**

This candidate adds **one sender file and its tests**. It does not modify the
existing Linux runner, credential vault, migrations, server, runtime database
permissions, or monitoring history previews. No route is mounted and no agent
will automatically transmit data after installation.

## Contract and boundaries

- Explicit HTTPS origin, exact fixed **proposed** path `/api/agent-telemetry/v1`.
  The service has **not** yet been shown to mount this path. Agree and test the
  production route before actual network connection.
- Caller supplies its already-protected machine credential, a previously
  generated canonical UUID v4 submission ID, and a real telemetry envelope.
- Sender accepts only strict, measured version-1 envelope shapes; rejects
  duplicate metric names, malformed timestamps, out-of-contract fields and
  oversized bodies. The server remains the final validator.
- Sender makes **one** `POST` attempt via an explicitly provided fetch. With
  Node `globalThis.fetch`, standard certificate and hostname verification must
  remain enabled; TLS verification was not tested by the offline unit suite.
- Authorization header holds the credential. JSON body holds **only** the
  submission ID and envelope, with no organization/agent selector.
- Redirect following is disabled; no cookies or credentials in URLs.
- Handles success: `202 {"status":"inserted"}` and
  `200 {"status":"duplicate"}`.
- Handles `401`, `400/413/415`, `409`, bounded `429 Retry-After`, and unknown
  failures using sanitized typed errors. No token, URL, or provider exception
  content is returned in error messages.
- **No automatic retry.** On an ambiguous timeout/network failure, retry must
  use the SAME submission ID and UNMODIFIED envelope. Durable pending-submit
  storage and agent quota backoff are a separate future integration step.
- Local maximum request size is a conservative **16 KiB**. Compare it with
  `MAX_INGESTION_BYTES` and document any authorized adjustments before wiring.

## Install and verify

From the Pulse Metrics repo root, first inspect the zip contents. After
confirming it contains only this README and the two new transport files,
extract it at repo root, then run:

```bash
npm run lint
npm test
npm run build
git diff --check
git status -sb
```

The tests use only injected in-memory transports. They do **not** establish:
real TLS trust, WorkOS authorization, agent enrollment, PostgreSQL ingestion,
rate-limit enforcement, read-only history, or public deployment readiness.

## Next controlled step

After the offline candidate passes, independently review the actual ingestion
route and body-size limit; construct an isolated HTTPS + temporary PostgreSQL
test with documented certificates, revocation and cross-organization denial.
Do not open any ingress path in the normal `server.ts` or public reverse proxy
based solely on these tests. Keep existing `PUBLIC LAUNCH: NO_GO` restrictions.
