# Pulse Metrics — D15C-5U-2F2J: Read-only pilot identity and membership evidence

**Status:** Local verification candidate; disposable SQL has not yet been run against the owner's live PostgreSQL.
**Launch:** NO_GO. Identity review is not an enrollment, database-write or production approval.

## Purpose

2F2I supplies an independently signed, time-limited proposal for exactly one owner, organization and active monitoring agent. 2F2H proved the quarantined development database is safely read-only and EMPTY ONLY. Those facts must not be treated as permission to let an agent write telemetry.

2F2J adds a **separate pre-telemetry identity verification**: one organization, one user, one `owner` membership joining the two, one `active` agent belonging to that organization, one unrevoked credential with exactly `telemetry:write` scope, **zero telemetry samples/submissions**, and unchanged migration/RLS/least-privilege evidence.

The 2F2I signed proposal still requires a future bounded telemetry count of 1–100. This 2F2J zero-sample identity audit does **not** change that requirement or reuse the existing 2F2G nonzero policy as a zero-data bypass.

## Delivered new files

- `scripts/telemetry-persistent/pilot-identity-evidence.sql`: PostgreSQL 16 repeatable-read, read-only SQL for **only an existing disposable replay** at `/tmp/pulse-replay-XXXXXXXXXX/{data,socket}`, port 55432 and no TCP. One nonsecret JSON evidence record, no credentials/hashes/WorkOS subjects.
- `scripts/telemetry-persistent/pilot-identity-evidence.mjs`: independent, exact-shape checks on the SQL output and an offline comparison with the already verified 2F2I Ed25519 manifest. Neither result is runtime authorization.
- `scripts/telemetry-persistent/review-pilot-identity.mjs`: offline plan, offline evidence shape validation and signed offline comparison. No database connection.
- `scripts/telemetry-persistent/read-disposable-pilot-identity.sh`: **opt-in, read-only** query of a **previously running** disposable replay only; pinned SQL fed to `psql` through stdin so `postgres` never traverses the owner's home directory. It never starts/stops any database or targets 55433.
- `scripts/telemetry-persistent/pilot-identity-evidence.test.mjs`: 22 offline regression cases for owner membership, cross-organization agents, credentials, unexpected extra identities, sample counts, unsafe roles, and adapter boundaries.

No other sources are replaced. Existing 2F2G/2F2H, PostgreSQL data and backup content, environment files, signing keys, enrollment endpoints, and telemetry routes are unchanged.

## Local installation test

```bash
cd ~/Projects/pulse-metrics
node --test scripts/telemetry-persistent/pilot-identity-evidence.test.mjs
node scripts/telemetry-persistent/review-pilot-identity.mjs --plan
bash scripts/telemetry-persistent/read-disposable-pilot-identity.sh --plan
```

## Disposable-only live SQL adapter (not part of normal installation)

`--audit-existing-disposable` requires an independently prepared **existing and running** disposable PostgreSQL 16 at port 55432 with a single synthetic owner/organization/active agent/credential and NO telemetry. The prior two-tenant 2F2F rehearsal fixture is intentionally **not** eligible; it should fail closed. Do not run this against the quarantined persistent 55433 cluster, and do not start/modify/seed a database merely to make it pass.

When a separate disposable rehearsal provides that exact fixture, an authorized operator may run:

```bash
cd ~/Projects/pulse-metrics
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/read-disposable-pilot-identity.sh \
  --audit-existing-disposable /tmp/pulse-replay-XXXXXXXXXX/socket
```

The `XXXXXXXXXX` placeholder must be replaced with the **verified** actual temporary replay identifier; this package does not discover or invent one. The adapter will refuse if that cluster does not exist or its SQL security facts do not match. It neither issues a signed approval nor says the chosen owner exists in the protected database.

**Important:** A JSON evidence file supplied by a caller is NEVER a live database attestation, even if it contains a plausible `source` field. The offline comparison confirms structure and signature, not independent PostgreSQL provenance. A signer/trust-anchor ceremony, actual verified WorkOS subject, and a separately approved nonempty persistent lifecycle remain outstanding.

## Completion boundary

Passing 22/22 offline tests is a **candidate** result, not a 2F2J live-database completion. Proving a real SQL snapshot requires a single-tenant disposable fixture and the separately controlled disposable read-only operator. Later, a separate reviewed nonzero persistent lifecycle must verify recovery and bounded telemetry, without weakening 2F2H or the current zero-data operator.

**NO ENROLLMENT | NO PERSISTENT WRITES | NO PUBLIC LAUNCH.**
