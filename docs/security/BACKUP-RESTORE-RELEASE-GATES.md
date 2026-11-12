# Pulse Metrics — Phase 2E3C5D1: Disposable backup/restore rehearsal

**Status:** Local, isolated recovery verification package. **Not** an authorized production deployment, live-database backup, release/upgrade runner, or disaster recovery certification.

**Reviewed starting commit:** `9bbb034090098a911519234bcfae4acff31d2fe4` on `feat/identity-organization-onboarding`.

## Purpose

The earlier phases established: (a) a reproducible initial Drizzle migration; (b) six reviewed privileged SQL bootstrap steps; (c) a protected receipt ledger for *fresh replay*; (d) read-only adoption audits; and (e) a strictly separate `verified_existing` rehearsal. **This phase tests whether a PostgreSQL logical backup can restore the schema, test data and those security controls, not just whether a dump file can be generated.**

## Test boundary

`bash scripts/test-backup-restore-rehearsal.sh` first verifies the local runtime configuration and invokes the existing **read-only** adoption/drift audit of the original development database. It initializes an entirely separate PostgreSQL 16 cluster under a random, marked `/tmp/pulse-replay-XXXXXXXXXX` directory, owned by the `postgres` OS account. Its server has **no TCP listener**, and all write-capable commands carry its explicitly verified private Unix-socket path and port `55432`. It never dumps, renames, drops, restores, seeds or applies DDL to the existing local `pulse_metrics` installation.

The test uses original checked SQL sources and the real Drizzle migrator, installs the private receipt ledger, applies and records all six reviewed privileged steps, and inserts synthetic records in the following areas:

- WorkOS-style subject (not a real identity), organization and owner membership;
- monitored agent and **synthetic** telemetry sample;
- organization invitation (placeholder digest), audit events and rate-limit bucket;
- original Drizzle ledger and six privileged fresh-replay receipts.

A `pg_dump --format=custom` backup is saved to a restricted temporary file. Its table-of-contents is inspected. Then **only in that disposable cluster**, the synthetic source database is renamed to `pulse_metrics_backup_source`, an empty database named `pulse_metrics` is created and minimally bootstrapped, and `pg_restore --single-transaction --exit-on-error` restores the archive. Both source and restored data and catalog snapshots are compared. The script runs the existing RLS/privileged-ledger audits again, checks a telemetry sequence value, and probes the restored application role for forbidden access to secrets, private receipts and DDL.

The recovery-only verifier `scripts/recovery/verify-restored-catalog.py` compares the original and restored catalog snapshots without changing either. It pins the original catalog SHA-256, compares every metadata line, and only tolerates the two exact text-cast array representations reviewed after the first restore run. The original source remains strict and unchanged. Any additional mismatch is printed (metadata-only) and fails the test. The verifier has eight standalone negative/positive regression cases.

The *entire* temporary cluster, including backup archive and synthetic test rows, is removed after a verified shutdown. A cleanup failure is treated as a test failure and prints the retained path for inspection.

### Recovery assertions

1. Original Drizzle history has exactly the authentic reviewed initial migration hash.
2. All six original privileged receipts survive and are still marked `fresh_replay`; this phase does not pretend to install `verified_existing` history.
3. Tenant, agent, telemetry, invitation, audit and rate-limit synthetic fixture rows are restored unchanged. Fingerprint includes the telemetry sequence state.
4. The original `public` catalog still matches the independently pinned reviewed fingerprint. On restore, all catalog lines must remain byte-identical **except** two exact, reviewed PostgreSQL 16 `CHECK`-constraint deparse spellings (`invitation_rate_limits_action` and `invitation_rate_limits_kind`). The verifier rejects any other difference, including changed policies, grants, roles, functions or constraint values.
5. The private migration schema and receipt table remain inaccessible to the ordinary runtime role.
6. The original development database catalog remains at its previously reviewed hash.

**Scope limitation:** The catalog inventory only covers enumerated security metadata; the content fingerprint only covers the synthetic tables and ledgers selected by the fixture SQL. The script is a trusted-synthetic-data functional test, not a proof of all possible PostgreSQL object types, historical point-in-time recovery, or actual production dataset recovery.

## Critical role/global-object limitation

`pg_dump` backs up **one database**, not cluster-wide roles or tablespaces. This specific drill stays in one **disposable** cluster, where the migration/runtime/executor roles already exist; it does not demonstrate rebuilding roles on an empty replacement cluster. A real disaster recovery procedure must independently capture and securely manage necessary global objects and provision/restrict roles before restoration (with audited `pg_dumpall --globals-only` or an explicitly versioned role-provisioning method). No real credentials are read, copied or tested here. See [PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).

The synthetic archive is not encrypted because the disposable test contains no real customer data. **Do not apply this storage pattern to production.** Real backups require encryption at rest/in transit, limited access, custody/audit logs, encrypted offsite copies, secure key management, defined retention/deletion, and tested recovery permissions.

## Production release gate plan — not implemented here

Before any upgrade/adoption against a real installation:

1. Require two explicit human signoffs (application owner and independent reviewer where possible), a reviewed commit/build artifact, and a maintenance/availability plan. Reject unknown environment/database identities.
2. Verify a freshly tested, encrypted restore point; separately verify role/global recovery, backup age, restore credentials, disk capacity, storage durability, and independent restoration from the actual backup destination. Publish RPO and RTO targets **after** testing and capacity measurements; they are not defined yet.
3. Introduce a dedicated non-superuser migration executor where feasible, with narrowly scoped administrator tasks for `BYPASSRLS` role creation; never run public API processes as a migrator or superuser.
4. Use a deployment-wide PostgreSQL advisory lock or equivalent orchestrated exclusivity, with `lock_timeout`, `statement_timeout`, clean abort semantics and independent migration history checks. Do **not** treat this rehearsal as having implemented production locking.
5. Run source/ledger checks and structural drift checks **before** acquiring the release lock and again while the lock is held. Resolve the original admin SQL-to-receipt crash gap through reviewed operator reconciliation, not blind re-execution.
6. Apply only separately reviewed, forward-compatible migrations. Plan transactional and nontransactional steps separately. Use expand-and-contract for API/database compatibility and verified pause/drain where needed.
7. Validate privileges, RLS, tenant isolation, ingestion behavior, schema and data on completion. On failure, freeze writes as needed and execute a tested restore/roll-forward playbook; rollback of an application binary does not automatically reverse a schema migration.
8. Keep public ingress, unmounted invitation acceptance and unverified telemetry ingestion disabled until the full security/reliability release checklist is met.

**Open work for Phase 2E3C5D2+**: real backup storage and encryption, global-object recovery in a *second isolated cluster*, release locking rehearsal, negative restore/failure cases, PITR/WAL strategy, point-in-time restore evidence, RPO/RTO, monitoring, operator runbook and staged rollout approvals.

## Run

From the local clean project checkout, after reviewing the script:

```bash
cd ~/Projects/pulse-metrics
bash -n scripts/test-backup-restore-rehearsal.sh
python3 scripts/recovery/verify-restored-catalog.test.py
bash scripts/test-backup-restore-rehearsal.sh
```

The wrapper needs `sudo` access to `postgres`, version-matched PostgreSQL 16 binaries including `pg_dump` and `pg_restore`, `node`, `psql`, installed project dependencies, and the existing local read-only audit prerequisites. It creates test-only cluster state under `/tmp`. On success, all transient test state and the backup archive are removed. **The working installation is never adopted or changed.**

> **Standard:** Test recovery, not only backup creation. No fabricated measurements. No invented migration history. BUILT TO LAST.
