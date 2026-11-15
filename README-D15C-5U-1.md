# Pulse Metrics D15C-5U-1 — Opt-in local development agent composition

**Status:** UNMOUNTED REVIEW CANDIDATE. **PUBLIC LAUNCH: NO-GO.**

The original development database passed its read-only adoption/security audit,
but the enrollment and telemetry ingestion schemas are not installed in that
database. Do **not** apply the disposable rehearsal's privileged migrations to
that database or backfill historical migration receipts.

## New files only

- `src/agent/transport/local-dev-one-shot.ts` — guarded library routine that
  reads an owner-only machine credential, verifies it against **independently**
  expected organization and agent IDs, collects genuine Linux metrics, and makes
  **one** HTTPS transmission to explicit IPv4 loopback.
- `src/agent/transport/local-dev-one-shot.test.ts` — offline test, no PostgreSQL,
  no HTTP listener, and no externally transmitted credentials.

Neither file imports into `server.ts`, `run-linux-agent.ts` or any executable
startup. No real credential or genuine endpoint is provisioned by this package.

## Safety gates

- Linux only; refuse `NODE_ENV=production` and disabled TLS verification.
- Exact opt-in `PULSE_D15C5U_LOCAL_ONLY=YES` required **at runtime**.
- Only canonical `https://127.0.0.1:<port>` origins (port >= 1024) allowed.
- Read vault using the existing owner-only secure-storage primitive.
- Require both independent expected IDs; never trust browser/agent-side tenant
  selectors. IDs are used only for local consistency checks.
- Verify transport *before* touching the vault; sender never automatically
  retries or follows redirect.
- Do not print, return or persist raw machine credentials.
- Not a general remote agent CLI or persistent monitoring process.

**IMPORTANT:** Although this library can be called from a trusted test harness,
it must NOT be wired into the application or run against a persistent credential
until a separate development-only server and database are provisioned through a
reviewed process. Any caller must use a TLS-verifying `fetch` implementation.

## Verification on adap

From repository root, after installing exactly these new files:

```bash
npm run lint
npm test
npm run build
git diff --check
git status -sb
```

The new test should bring the test count from **527 to 532**, assuming no other
new test files have been added in the meantime.

## Next engineering gate

Implement a **separate, dedicated development database** with replayable,
reviewed migrations and an explicitly loopback-bound TLS ingestion service.
Do not retrofit this into existing `pulse_metrics` by treating the six legacy
administrator SQL executions as fresh replay receipts. After that, use verified
identity and RLS-scoped read-only history to demonstrate dashboard measurements.
