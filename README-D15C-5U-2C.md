# Pulse Metrics — D15C-5U-2C: New persistent development migration candidates

**Status:** Source-level remediation candidate. **NOT approved for installation.**

## Why we are doing this

The persistent 5U-2 cluster at `/var/lib/postgresql/pulse-metrics-dev-5u2`
completed the original Drizzle migration, all six privileged migration steps,
enrollment and D15B ingestion. It then correctly refused the D15C network
quota migration: the original SQL deliberately supports ONLY a disposable
`/tmp/pulse-replay-*` PostgreSQL cluster. The agent quota and credential outcome
revisions have the same disposal-only boundary.

The retained persistent cluster is **quarantined and stopped**, with no seed
organizations, agents or telemetry. The original `pulse_metrics` database is
unmodified. **Do not rerun `--apply` or `--resume`.**

This package creates **three new full SQL candidate artifacts** with:

- **Separately named versioned development candidate files** and a manifest of
  both source and candidate SHA-256 digests.
- **Original migration sources unchanged**; their source SHA-256s are pinned in
  the generator. No original SQL file is overwritten.
- **Only two intended differences**: a new development-candidate comment header
  and the first PostgreSQL environment preflight guard. The original quota
  thresholds, function definitions, security-definer owners, ACLs, RLS policies,
  function-body hash checks, transaction boundaries and migration receipts remain
  byte-for-byte identical after that guard.
- **Two narrowly allowed contexts**, each requiring local Unix-socket use,
  `postgres` administrator, PostgreSQL 16 and TCP disabled:
  1. Exact persistent development data/socket directory on port 55433.
  2. The original marker-verified disposable replay data/socket shape on port 55432.
- All other paths, ports, ordinary development DB, staging and production
  are outside the allowed context. The header explicitly states NOT approved
  for deployment.

Allowing the disposable replay context is intentional: it lets the *actual new
SQL artifact bytes* run through the existing PostgreSQL regression suite before
any persistent database is touched.

## Included complete files

- `scripts/telemetry-persistent/release-candidates.mjs`
- `scripts/telemetry-persistent/release-candidates.test.mjs`
- `scripts/telemetry-persistent/run-disposable-release-rehearsal.mjs`

No existing project files are replaced.

## First: offline source generation

Run from the repository root:

```bash
node scripts/telemetry-persistent/release-candidates.mjs --plan
PULSE_APPROVE_5U2C_GENERATION=OFFLINE_FILES_ONLY \
  node scripts/telemetry-persistent/release-candidates.mjs --write
node scripts/telemetry-persistent/release-candidates.mjs --verify
node --test scripts/telemetry-persistent/release-candidates.test.mjs
npm run lint
npm test
npm run build
```

The `--plan`, `--write` and `--verify` commands **never connect to a database**.
`--write` only creates new candidate SQL files in
`scripts/telemetry-persistent/migrations/` and a companion manifest.
`--write` uses exclusive create and refuses to overwrite existing files.
`--verify` reconstructs and byte-compares all three artifacts and the manifest.

## Next: independent, fully disposable PostgreSQL regression

The repo must have the previously passed D15C-4B disposable test harness and
the D15C-5U-2B1 offline quarantined-cluster inspection file in place.

```bash
PULSE_APPROVE_5U2C_DISPOSABLE_REHEARSAL=YES \
  node scripts/telemetry-persistent/run-disposable-release-rehearsal.mjs --run
```

This runs a temporary **complete derived copy** of the existing committed,
marker-verified disposable PostgreSQL rehearsal. It substitutes only the three
new SQL paths and the matching hashes. The test harness and original locked SQL
remain untouched. The temporary script is created under `/tmp` and removed at
completion; the disposable PostgreSQL cluster has its own mandatory cleanup.
The wrapper independently checks that the quarantined persistent cluster is
stopped, and that the original developer DB fingerprint matches, **both before
and after** the disposable rehearsal.

The rehearsal includes atomic-rollback, duplicate-install refusal, restricted
runtime permissions, quotas, concurrent behavior, synthetic multi-tenant
fixtures, and credential rejection behavior. Fixture data is never inserted
into the persistent cluster.

## What this does NOT authorize

- No application to `/var/lib/postgresql/pulse-metrics-dev-5u2`.
- No production, staging or ordinary development database deployment.
- No agent enrollment, credential loading, API mounting or network listener.
- No auto-retry of prior failed migrations.
- No schema promotion without source review and a separate audited release gate.

After the tests pass, review the three full generated SQL artifacts and their
SHA-256s. The **next separately approved milestone** is a guarded resume
procedure which independently checks that the quarantined cluster is at the
precisely inventoried stage: Drizzle 1, historical receipts 6, enrollment 1,
ingestion 1, quota 0, agent quota 0, no data, expected owner/ACL/RLS. It must
reverify PostgreSQL identity, immutable SQL hashes, and readiness conditions
before applying anything. It must not rerun earlier migrations.

**Public launch: NO-GO.**
