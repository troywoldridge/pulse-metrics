# Pulse Metrics — Phase 2E3C5D2: Two-cluster recovery rehearsal

**Status:** Local, synthetic, isolated recovery verification. **Not production disaster recovery certification**, not a production restore command and not an authorization to modify the working database.

**Reviewed starting checkpoint:** `53dda6c6408a95a71498c6a2239536969006dbcb` on `feat/identity-organization-onboarding`.

## Scope and threat boundary

Run `bash scripts/test-full-cluster-recovery-rehearsal.sh` only after reading it. The test uses two independent disposable PostgreSQL 16 clusters, both created by the `postgres` operating-system account under unique, marked `/tmp` directories. Both disable TCP listeners, require PostgreSQL peer authentication, and use separate explicit Unix socket paths/ports. It verifies socket identity and data directory before write-capable operations. Each cluster is stopped and removed by a marker- and path-guarded cleanup trap; a cleanup failure reports its location and makes the test fail.

The *existing development installation* is touched only by existing strictly read-only source/security/catalog checks before and after the experiment. It is **never backed up, restored, seeded, renamed, dropped or migrated** by this test. All database rows are synthetic.

### The exercise

1. Confirm local development-only connection config, unchanged reviewed original Drizzle/admin migration sources and unmodified existing baseline. Select PostgreSQL binaries matching the existing major version.
2. Create an independent **source** cluster. Initialize the original source roles, database, real Drizzle migration and six privileged SQL steps with exactly six `fresh_replay` receipts. Insert synthetic organization/user/membership, monitored agent/telemetry, invitation, audit and rate-limit data. Capture row/sequence and catalog/role inventories.
3. Produce **two different backup artifacts** from that disposable source: `pg_dump -Fc` for the application database and `pg_dumpall --globals-only --no-role-passwords` for roles, memberships and other cluster-global SQL. Verify required database archive entries and secure the files with restricted permissions. These artifacts are not encrypted because they contain only fabricated test data and no real credentials.
4. Initialize a completely **separate replacement cluster** using an intentionally different bootstrap superuser, `pulse_recovery_bootstrap`, so restoring `CREATE ROLE postgres` from the original unedited global backup does not conflict with an already-existing `postgres` role. Verify that `postgres`, `pulse_metrics_app` and `pulse_metrics_migrator` are absent before restoring global roles. This follows PostgreSQL 16 guidance for `pg_dumpall` globals restoration.
5. Copy both backup artifacts to the private replacement directory; compare SHA-256 digests to the originals. Reject a deliberately truncated archive. **Shut down the source cluster and confirm that it is offline before restoring** anything on the replacement. This prevents accidental dependence on the original disposable server.
6. Restore the **unmodified** `pg_dumpall --globals-only` SQL with `ON_ERROR_STOP=1`, then run `pg_restore --create --exit-on-error` into the replacement. Since `CREATE DATABASE` is not transactional, this specific full-database restore is *not* a single global transaction. A failure rejects and discards the entire isolated target instead of treating it as a partially successful recovery.
7. Verify synthetic data and telemetry sequence fingerprint, original Drizzle ledger and six receipts, RLS/function invariants, private ledger protection, original public catalog parity, and explicit cluster role, membership, database grant and per-database role settings inventories. The existing reviewed PostgreSQL 16 catalog comparison allows only two **exact** documented text-deparse variations of `invitation_rate_limits` CHECK expressions; all other differences fail.
8. Connect using the restored restricted application role and prove denial of private credential tables, private migration receipts, rate-limit table reads and schema creation. Recheck the original development database catalog without writing anything. Remove both test clusters and archives.

## What is and is not recovered

This rehearses restoration of a **single application database plus its global PostgreSQL roles**, into a separately initialized cluster on the *same trusted local Linux machine*. It checks the role security attributes relevant to this application and database-scoped privileges/settings. It does **not** prove that unrelated databases, production passwords, filesystem-level backups, custom tablespaces, replication slots, background jobs, secrets or OS/system configuration can be recovered. The replacement deliberately retains its additional test-only bootstrap superuser; the inventory excludes that extra role, and this setup must not be copied unmodified into a production server. No real credentials are restored because `--no-role-passwords` is used. Real recovery would require a separate, secure credential-reprovisioning and key-rotation procedure.

The test is not point-in-time recovery (PITR), WAL archiving, zero data loss, a recovery service, encryption/retention verification, or RPO/RTO measurement. Backup and restore are local and synthetic; operations have not been benchmarked under representative production data volume. `pg_dumpall` global SQL and `pg_restore` output from untrusted sources are dangerous because a database dump can execute privileged code: only the script-generated, trusted-synthetic artifacts are accepted by this test.

**Production release gates remaining:** operator approvals; secure encrypted backups including off-site copies; validated key custody and recovery secrets; defined RPO/RTO and measured restore time; WAL/PITR strategy; actual restore from backup storage; migration locking and safe rollout; resource monitoring; outage communications; and an independently approved recovery runbook. Until all are demonstrated, do not enable public ingress or live tenant onboarding based on this test alone.

## Local run

From a clean project at the reviewed Git commit, install only the three additive files from the guarded package and review them. Then:

```bash
cd ~/Projects/pulse-metrics
bash -n scripts/test-full-cluster-recovery-rehearsal.sh
bash scripts/test-full-cluster-recovery-rehearsal.sh
python3 scripts/recovery/verify-restored-catalog.test.py
node --test scripts/migrations/verify-manifest.test.mjs
npm test
npm run lint
npm run build
npm run db:check
```

Prerequisites: Linux trusted developer host with sudo privileges for the `postgres` OS user, PostgreSQL 16 matching server tools (`initdb`, `pg_ctl`, `postgres`, `psql`, `pg_dump`, `pg_dumpall`, `pg_restore`, `createdb`), Node and installed repository dependencies. `pg_dumpall --no-role-passwords` is intentional. No application files are rewritten by the test. Tests are not production deployment instructions.

**Useful evidence:** look for two distinct Unix-only clusters, 9+ relevant roles in source inventory, copied-artifact hashes, rejection of the truncated archive, source shutdown before target restore, complete global SQL and database restoration, role/grant/setting parity, synthetic data parity, denied runtime access and safe cleanup of both clusters.

## Next increment: Phase 2E3C5D3

Rehearse explicit release approval, deployment-wide PostgreSQL advisory locking and contention, migration failure/retry handling, protected rollback boundaries and auditable release records. All tests should continue to run locally without changing the existing development database.

**Standard:** no copied passwords, no fabricated history, no skipped PostgreSQL restore errors, no production access. BUILT TO LAST.
