# Pulse Metrics — Phase 2E3C5C2B: Existing-installation adoption rehearsal

**Status:** Local-only **disposable PostgreSQL-cluster rehearsal**. No adoption operation is authorized for the existing working database or production.

**Reviewed start:** `41734c0c62ca7afb3fb3486b8e281c4ba3976d59` (`feat/identity-organization-onboarding`).

## Purpose and provenance

Legacy developer installations have one authentic Drizzle migration and the objects from six privileged SQL administrator scripts, but have **no records showing execution of the six steps through the new receipt runner**. The six scripts contain non-idempotent DDL and global roles, so replaying them against such an installation is unsafe. Their historical execution times and exact historical source bytes cannot be reconstructed merely from today's catalog structure.

The migration system must distinguish:

| Concept | Meaning | What is recorded |
|---|---|---|
| `fresh_replay` | A script ran through the guarded runner and was independently recorded after execution | One execution receipt per step in `applied_privileged_steps` (tested in earlier phases) |
| `verified_existing` | An already-existing installation has a catalog matching the pinned approved structure and approved source manifest at inspection time | **One** current-state attestation in `verified_existing_baselines`; **zero** fresh execution receipts |

The `verified_existing` attestation **does not** state that the historical scripts were originally run from the currently reviewed file contents, does not claim an execution timestamp for past changes, and does not create or modify Drizzle ledger rows. It is an observed-state adoption *rehearsal*, not a production release mechanism.

## Files introduced

- `scripts/test-existing-adoption-rehearsal.sh`: independent complete shell runner. Uses a new PostgreSQL 16 cluster under a unique, verified `/tmp/pulse-replay-XXXXXXXXXX/` directory; Unix socket only; no TCP listener, no network credentials, and no shared cluster roles. The current `pulse_metrics` installation is queried read-only.
- `scripts/migrations/adoption-attestation-bootstrap.sql`: adds a **separate** `pulse_security_migrations.verified_existing_baselines` table, owned by migrator with forced RLS and no policies or API access. It is only invoked against the isolated cluster, after installing the already-tested empty private receipt schema.
- `scripts/migrations/adoption-attestation-record.sql`: guarded insertion of exactly one `verified_existing` observation, tied to source manifest and public catalog SHA-256 fingerprints. It refuses an existing attestation, any fresh receipts, unexpected Drizzle history, unprotected attestation storage, or missing critical privileged functions.
- `scripts/migrations/adoption-attestation-audit.sql`: read-only inspection requiring exactly one `verified_existing` record, **zero** `fresh_replay` receipts and a single original Drizzle ledger record.

## Rehearsal steps

1. Verify local-only `.env`, original Drizzle migration hash and immutable six-script manifest.
2. Run the previously validated, **read-only** existing-installation drift/adoption audit.
3. Initialize a completely separate PostgreSQL cluster with the same PostgreSQL major version, no TCP listener, peer authentication, and minimal separate roles.
4. Run the real original Drizzle migration and six reviewed administrator scripts **without** privileged migration receipts. This deliberately simulates the pre-ledger installation that already exists on `adap`.
5. Prove the isolated legacy-style structure exactly matches the pinned catalog fingerprint of the existing installation. Run the verified security baseline audit.
6. Install an empty, private receipt ledger, and the new separate adoption attestation table. Refuse any attempt to blindly rerun step `001` while its legacy function already exists.
7. Deliberately inject one unsafe SELECT grant **only in the isolated cluster**; verify catalog drift and **no adoption attestation**. Revoke it and verify the previous catalog fingerprint returns.
8. Recheck reviewed source manifest, existing catalog, Drizzle ledger, and store **one** `verified_existing` current-state attestation. Verify digest values and SQL postconditions.
9. Try the same attestation a second time; require a fail-closed rejection and preserved original record. Confirm authenticated restricted-role connection cannot read private attestation or migration receipts.
10. Confirm public catalog remains an exact match and original Drizzle ledger is unchanged, then stop and delete the entire isolated cluster.

## Operator commands

After reviewing the full script and SQL, and verifying a clean Git checkpoint before installing the package:

```bash
cd ~/Projects/pulse-metrics
set +e
bash -n scripts/test-existing-adoption-rehearsal.sh
bash scripts/test-existing-adoption-rehearsal.sh
ADOPTION_REHEARSAL=$?
echo "Existing-state adoption rehearsal: $ADOPTION_REHEARSAL"
git status --short
```

Then run prior regression tests and build separately:

```bash
bash scripts/test-fresh-cluster-replay.sh
node --test scripts/migrations/verify-manifest.test.mjs
npm test
npm run lint
npm run build
npm run db:check
```

**Do not commit until all checks pass and the complete diff is reviewed.**

## Non-goals and next release gate

- **NO existing-database adoption write.** The real `pulse_metrics` has not been given the new attestation table or any receipts by this phase.
- **NO execution provenance forgery.** Matching structural metadata verifies only the enumerated catalog surface, not original execution dates, row data, all ACLs, extensions or complete privilege equivalence.
- **NO production migration release.** The SQL files are designed for the guarded isolated rehearsal only; they are not approved for manual execution against the existing database.
- For an eventual real adopter: require a separate explicitly authorized maintenance procedure with deployment locks, a reviewed backup and restore, independent operator signoff, stronger catalog and privilege inventory, drift-free attestation immediately before writes, and a post-adoption regression test. Implement a deployment policy so the normal migration runner treats `verified_existing` as a separately authorized baseline rather than as six newly executed scripts. Do **not** weaken the immutable ledger or backfill `fresh_replay` receipts.
- Existing privileged scripts contain administrator-wide role operations and are not suitable for a generic managed-PostgreSQL deployment without separate review.
- No invitation acceptance activation, production ingress, public WebSocket, SSH or fabricated telemetry is enabled.

**Security principle:** observed state is evidence, not invented history. **BUILT TO LAST.**
