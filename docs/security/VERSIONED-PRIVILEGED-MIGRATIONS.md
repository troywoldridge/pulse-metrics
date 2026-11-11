# Pulse Metrics — Phase 2E3C5C1: Checksummed privileged SQL migration receipts

**Status:** Local replay verification + read-only existing-installation adoption assessment. **NOT a production migration adopter.**

**Reviewed starting Git checkpoint:** `ab6865da5576e869623a2994702e905c305a909f` on `feat/identity-organization-onboarding`.

## The provenance problem

The original Drizzle schema migration (`0000_damp_tomorrow_man`) is tracked by the authentic `public.__drizzle_migrations` ledger. Six administrator SQL files (`scripts/admin/001_*` through `006_*`) were subsequently executed in local development before a separate privileged migration ledger existed. Some create global `NOLOGIN BYPASSRLS` function-owner roles. Several deliberately reject existing functions or tables and cannot safely be rerun.

**Never** add fake Drizzle rows for these six operations, and **never** claim that a newly backfilled record proves the historical execution time or source bytes of an earlier manual command. The first six scripts are immutable *reviewed-source baselines*, not automatically deployable updates to an existing installation.

## Scope of this increment

- `scripts/migrations/privileged-manifest.json`: six ordered steps, exact script paths, SHA-256 checksums, expected privileged function signatures, and original Drizzle source/journal locks.
- `scripts/migrations/verify-manifest.mjs`: independently pins those values in reviewed source code. Refuses modified, reordered, missing, untracked or changed SQL. **Never connects to PostgreSQL.**
- `scripts/migrations/verify-manifest.test.mjs`: Node tests for intact sources and tamper detection.
- `scripts/migrations/ledger-bootstrap.sql`: inside the **disposable cluster only**, creates `pulse_security_migrations.applied_privileged_steps` in a dedicated schema **outside `public`**, owned by `pulse_metrics_migrator`, with `ENABLE` and `FORCE` RLS and **no RLS policies**, no app privileges, and no direct access through ordinary API login.
- `scripts/migrations/ledger-record.sql`: after each successful, unmodified administrator script, as isolated `postgres`, verify the expected privileged function (and for 003/006 the forced-RLS table) and record its manifest SHA-256 with `recorded_mode='fresh_replay'`.
- `scripts/migrations/ledger-audit.sql`: verify the **six exact** receipts, check RLS/ownership, runtime denial, and make sure Drizzle still has only one genuine entry.
- `scripts/test-fresh-cluster-replay.sh`: **complete replacement** of previous tested script, retaining its local safety guards, isolated Unix-only cluster, original Drizzle migrator, six unchanged administrator SQL sources, restricted-role tests, structural fingerprint parity, and verified cleanup. Adds the manifest and privileged receipts, then reruns the step-selection logic and requires six skips.
- `scripts/migrations/check-existing-adoption.sh`: **read-only** evaluation against the existing local `pulse_metrics`. It checks reviewed source hashes, previous security audit, and the absence of a previously installed privileged ledger. It **does not** write or backfill any record.

The new ledger lives in a non-public schema, so the existing deterministic `scripts/replay/catalog-manifest.sql` continues comparing the *original application-security schema* without treating these test-only receipts as drift. The ordinary runtime role also cannot read the ledger or its schema.

## Run locally (after review)

```bash
cd ~/Projects/pulse-metrics
set +e
node --test scripts/migrations/verify-manifest.test.mjs
node scripts/migrations/verify-manifest.mjs
bash scripts/migrations/check-existing-adoption.sh
bash scripts/test-fresh-cluster-replay.sh
npm test
npm run lint
npm run build
npm run db:check
```

Expected repeat-run output is six `SKIP 00N` lines. The new restricted-role probe must reject reading `pulse_security_migrations.applied_privileged_steps`. Catalog fingerprints must still match and disposable-cluster cleanup must succeed.

Review the entire replay wrapper before executing it. It uses `sudo` to initialize and delete only a unique, marked `/tmp/pulse-replay-XXXXXXXXXX` cluster. Existing `pulse_metrics` is inspected **read-only**, and none of these new scripts automatically install or modify any ledger there. No remote PostgreSQL, production credentials, Nginx, Cloudflare, agent enrollment or invitation acceptance are enabled.

## Crash and security boundaries

The original six bootstrap scripts own their own PostgreSQL transactions. Receipt insertion happens **after** each script succeeds; the receipt and privileged SQL cannot be treated as a single atomic transaction. If a process crashes between them, a missing receipt does **not** justify blind replay or manual backfill: an operator must reconcile the actual object state, source checksums and audit evidence. The replay test uses a disposable cluster; cleanup discards such partial state.

Passing this test demonstrates a working **fresh-cluster receipt model** and checked-source repeat skips. It does not make the previously installed local database ledger-aware, prove crash-recovery adoption, guarantee zero downtime, establish a production rollout/rollback system, or prove behavior across managed PostgreSQL providers.

## Next steps — 2E3C5C2 and 2E3C5D

1. Design an **explicitly reviewed existing-installation adoption protocol**. Prefer a distinct attestation status and provenance metadata rather than falsely claiming prior steps were freshly replayed. Require a complete baseline and structural parity check before any ledger write, and an operator-approved, separately versioned adoption operation.
2. Migrate the two post-Drizzle tables into Drizzle schema definitions and a safe staged migration plan **without** recreating already installed tables. Work out a deliberate adoption/ordering strategy first; do not add matching Drizzle entries to the current installation merely to silence a migration warning.
3. Plan locking/concurrent migration control, source-artifact signatures, snapshot/backup + restore rehearsal, non-transactional DDL failure recovery, least-privilege deployment credentials, production migration paths, and CI isolation.
4. Keep public activation blocked until real identity, telemetry and ingress safety are independently verified.

**Standard:** No invented history. No broad new grants. No hidden database changes. BUILT TO LAST.
