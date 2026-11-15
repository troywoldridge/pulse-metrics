# Pulse Metrics — D15C-5T Fully Isolated HTTPS → PostgreSQL Rehearsal

**Status:** Local-only integration candidate; PUBLIC LAUNCH: **NO_GO**.

## Objective

Prove an actual Linux collector envelope traverses the D15C-5R outbound HTTPS
sender, verified TLS (IP SAN 127.0.0.1, disposable certificate authority),
D15C ingress guards, the exact HTTP ingestion handler, the restricted
PostgreSQL gateway, and a separately initialized and destroyed PostgreSQL
cluster. Authenticate with synthetic credentials issued by the protected
D13 functions; do not use any customer's agent identity or secret.

## Why this test does not alter production components

- Does not change `server.ts`, agent runner, `src/db/schema.ts`, migration SQL,
  agent enrollment, or the ordinary development database.
- Builds a temporary **full-file copy** of the pinned existing
  `scripts/test-telemetry-agent-quota-http-rehearsal.sh` baseline and inserts
  a test-only call after the baseline's authenticated HTTP/DB audit.
- Requires baseline bytes match committed `78e6640`; refuses drift.
- Uses the original test's guarded Unix-only disposable PostgreSQL cluster,
  restricted `pulse_metrics_app` role and existing cleanup trap.
- Generates a fresh CA and server certificate into a removable owner-only
  temporary directory. The extra CA is scoped to one child Node process.
- Starts only a loopback HTTPS listener with an ephemeral port.
- Does not read `.env` values directly; the pinned database rehearsal performs
  its own development-only safety check without connecting to normal DB.
- No HTTP route is mounted in the ordinary `server.ts` application.

## Usage

Run from the repository root, after D15C-5R and D15C-5S are present:

```bash
cd ~/Projects/pulse-metrics
env -u NODE_OPTIONS bash scripts/test-telemetry-https-postgres-rehearsal.sh
```

If `NODE_EXTRA_CA_CERTS` was previously set, do not silently bypass the guard.
Review its purpose and use a clean shell/test invocation only after ensuring
no required account/server trust is being removed.

## Pass criteria

1. All existing D15C-4E PostgreSQL migration, quota, role and HTTP audits pass.
2. Independently issued synthetic agent credentials bind to two organizations.
3. The new sender transmits genuine Linux metrics over CA-verified HTTPS.
4. New row returns 202, exact repeat 200, changed repeat 409.
5. An identical submission UUID from a different tenant inserts independently.
6. Unknown and revoked credentials receive HTTP 401.
7. Test-only ingress network quota maps to HTTP 429; no automatic retry.
8. Unmounted legacy telemetry route returns 404.
9. A privileged post-test audit verifies **246** total rows (244 from baseline
   plus 2 from this test), two genuine Linux samples under distinct agents and
   organizations, and matching durable submission ledger rows.
10. Both temporary certificate files and the disposable PostgreSQL cluster are
    removed by their respective cleanup traps.

## Explicit limitations

This is an isolated *rehearsal*, not a deployed service. It does not prove
public Internet TLS termination, customer-installed agents, a production
credential lifecycle, actual tenant-authenticated browser history, or a
production release. The D15C-5R path `/api/agent-telemetry/v1` remains proposed;
this test uses it only on the isolated listener.

Never point this test at a working development or production database, add SSH
remote execution, bypass TLS verification, hardcode real machine identities,
or consider the public launch hold lifted.
