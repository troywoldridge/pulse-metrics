# Pulse Metrics — D15C-5U-2F2A: Disposable authenticated-history boundary rehearsal

**Status:** Ready for local test; not approved for persistent database activation.

## What this changes

- A **complete-file replacement** of `scripts/telemetry-https/verify-sender-to-postgres.mjs`, based on the source-review TAR archive with checksum `59e2cf45222f054b19180e94600c8f6bc1dd14c8cc53787541228dbae625ecb1`.
- A **new, test-only** `scripts/telemetry-https/disposable-tenant-history.mjs` that checks membership first inside a read-only, transaction-scoped PostgreSQL session, then reads only a tenant-bound agent's selected history fields.
- A matching `scripts/telemetry-https/disposable-tenant-history.test.mjs` with seven focused offline tests.

This preserves all existing SQL migrations, quota rules, runtime roles, `server.ts`, HTTPS sender, monitoring-history service, WorkOS authorization and the local operator. **It does not mount an API or change the persistent PostgreSQL database.**

## What the disposable PostgreSQL rehearsal verifies

- The existing D15C-5T genuine Linux sample is delivered by verified HTTPS into disposable PostgreSQL.
- Two independently enrolled, synthetic organizations can each retrieve their own stored sample through the restricted PostgreSQL app role.
- Each identity is derived from an existing, protected test-only fixture. A foreign organization is rejected **before** any organization context is applied.
- Membership in organization A does not reveal an agent belonging to B.
- Every history lookup executes inside `BEGIN READ ONLY` with transaction-local identity context. The PostgreSQL client is tested for unscoped visibility after rollback; suspicious connections are destroyed instead of returned to the pool.
- Selected history columns exclude raw JSON/credential secrets.
- The original D15C-5T telemetry, duplicate, revoked-credential and remaining SQL security checks continue to run.

## Important limitations

This is a **disposable PostgreSQL RLS/history integration test**, not an end-to-end WorkOS HTTP history test or a release of a live monitoring system. Synthetic fixture identities are used only in the disposable rehearsal. A separately reviewed authenticated local operating mode is still needed before real agents can write to the persistent 55433 cluster. `scripts/telemetry-persistent/local-development-postgres.sh` must retain its zero-operational-row and quarantine guards.

Do not set a ready marker, reuse disposable agent credentials, open public routes, or manually write telemetry to the persistent database. The main database and recovered persistent cluster must remain protected; **public launch NO_GO**.

## Test sequence

1. Confirm source archive and original target file checksum; extract the ZIP only into new staging paths.
2. Verify candidate hashes, run `node --check`, and run `node --test scripts/telemetry-https/disposable-tenant-history.test.mjs` from the staged package.
3. Install the complete replacement file and two new files, verify their final hashes.
4. Run `env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL bash scripts/test-telemetry-https-postgres-rehearsal.sh` on the Linux development machine. This uses the established fully disposable PostgreSQL rehearsal with ephemeral certificates and removes its test database.
5. Run `npm run lint`, `npm test` and `npm run build` and review `git diff --check` before committing.

If the disposable rehearsal fails, do not use the persistent 55433 cluster as a workaround. Preserve terminal output and inspect the exact stage. The original source remains available in Git (`git show HEAD:scripts/telemetry-https/verify-sender-to-postgres.mjs`) for controlled full-file restoration if needed.
