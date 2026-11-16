# Pulse Metrics — D15C-5U-2F2G Approval Isolation Correction

**Scope:** Two complete-file replacements plus this explanation. Not an authorization to write persistent telemetry.

## Diagnosis

The standalone 2F2G tests and `--verify` passed. During `--exercise-empty`, the operator received `PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE=START_AUDIT_STOP_NO_WRITES` and then started its own tests. The negative subprocess spawned by `pilot-inventory-policy.test.mjs` accidentally inherited that same approval. Instead of refusing, it entered a nested operator run and performed the older live database audit, triggering a Node recursive test-run warning. The negative test failed to find the expected refusal message. The outer operator then refused with `Policy regression tests failed`. A successful outer empty exercise was **not** verified by this log.

## Complete-file changes

- `scripts/telemetry-persistent/guarded-persistent-pilot.sh`: removes the exercise approval from the environment of `node --test`, preserving the exact approval check for the parent `--exercise-empty` command.
- `scripts/telemetry-persistent/pilot-inventory-policy.test.mjs`: resets the approval to an empty value for every subprocess by default, checks incorrect approval also refuses, and adds an explicit regression check that the operator drops approval before self-tests.

The standalone `pilot-inventory-policy.mjs` module, 2F2D zero-row operator, PostgreSQL migrations, retained backup, and public ingress are **unchanged**.

## Expected evidence

1. Verify the protected cluster is stopped and the retained backup digest still matches its pinned value **before** installing or retrying.
2. Verify the installed original two source hashes match the known 2F2G package.
3. Install complete replacement files only from the SHA-256 verified ZIP.
4. Run the tests with the approval deliberately set; the result should be **16 tests, 16 passed, 0 failed**.
5. Re-run `--verify`, then independently approved `--exercise-empty`, and perform final stopped-state and backup checks.

The previous failed run's three `NOTICE: PASS: schema receipts...` lines show that a nested database audit was reached. They do not prove the final protected cluster state. Any unexpected database state or failed shutdown is a stop condition; do not delete or repair PostgreSQL directories manually.

**Persistent writes: NOT APPROVED. Public launch: NO-GO.**
