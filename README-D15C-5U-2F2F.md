# Pulse Metrics — D15C-5U-2F2F: Nonzero telemetry audit contract

**Status: candidate / offline checks passed only.** This first gate of the proposed persistent-telemetry lifecycle does **not** authorize persistent database writes. **PUBLIC LAUNCH: NO-GO.**

## Purpose

Before introducing a separate persistent-pilot operating mode, verify that the existing disposable PostgreSQL rehearsal can pass an **independent, complete read-only audit when it contains nonzero data**. The established local-development operator (`local-development-postgres.sh`) intentionally refuses nonzero operational data and MUST NOT be loosened or replaced by this package.

## Files

- `scripts/telemetry-persistent/nonzero-pilot-ledger.sql` — a `BEGIN READ ONLY` audit that requires the exact disposable PostgreSQL identity, migration receipts, FORCE RLS and restricted grants; checks 246 expected sample rows and 246 submission rows, a one-to-one bidirectional ledger join, correct tenant and agent ownership for two genuine Linux samples, and active/revoked credential states. It does not accept arbitrary customer data.
- `scripts/telemetry-persistent/rehearse-nonzero-pilot-audit.sh` — isolated disposable-only shell gate. Supports only `--plan` and `--audit-disposable`, rejects inherited database URLs, production mode, unreviewed SQL, wrong Unix socket/data directory and unsafe database identity. Never starts/stops a cluster or writes to SQL.
- `scripts/telemetry-persistent/rehearse-nonzero-pilot-audit.test.mjs` — 11 fail-closed offline checks, including a test that simulates SQL tampering. Run as a non-root account.
- `full-replacements/scripts/telemetry-https/run-postgres-https-subtest.sh` — **complete replacement** for the existing runner (previous exact SHA-256 `adfa2bf1f92d3c7e6d2b509dd4204822f29194cc39b5d020bb0f4d5aec4ca472`). Preserves all earlier HTTPS / restart checks and runs the new audit *after* the existing 246-row restart assertion. Any failure aborts the parent rehearsal, whose disposable-cluster cleanup remains unchanged.

## Pre-install safety

1. Confirm branch `feat/identity-organization-onboarding` and that the current runner matches the previous SHA-256. No other committed or untracked files should be replaced.
2. Verify ZIP and all four source hashes independently. Extract into a private temporary directory and verify there before installing.
3. Install **only** the three previously nonexistent new files and the **entire** original runner replacement. Do not stage/copy the package's `full-replacements` directory into the repository; older review artifacts may already exist there.
4. Run offline tests and `--plan`; these must not access PostgreSQL.
5. Verify the quarantined persistent cluster remains stopped with `scripts/telemetry-dev/inspect-incomplete-persistent-development.sh`.
6. Run the existing fully disposable `scripts/test-telemetry-https-postgres-rehearsal.sh` with inherited Node/DB overrides cleared. The new 2F2F audit runs at the end of the nested PostgreSQL/HTTPS subtest.
7. Run TypeScript checks, application tests and build. Verify protected persistent source is still stopped at the end.

## Expected live evidence (not observed yet)

```text
========== D15C-5U-2F2F NONZERO PILOT READ-ONLY AUDIT ==========
NOTICE:  PASS: 2F2F nonzero rows, exact submission ledger and agent ownership audited read-only
NOTICE:  PASS: 2F2F FORCE RLS, credentials and least-privilege protections retained
========== D15C-5U-2F2F NONZERO LEDGER AUDIT: PASS ==========
READ-ONLY DISPOSABLE EVIDENCE ONLY | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO
```

The entire 5T / 2F2E rehearsal and disposable cleanup must still pass. A static test pass does not prove live database compatibility. On any refusal, do not relax the gate or manually remove PostgreSQL directories: inspect the failure and repair via full-file replacement only after review.

## What this does NOT prove

It does not enable machine enrollment, telemetry writes into persistent cluster port `55433`, production HTTPS, customer onboarding, offsite backup, PITR, automated retention, or a live monitoring service. The exact count of `246` is specific to the test fixture and **must not be carried into a commercial/persistent pilot operator**.

**Following milestone:** design and test an independent, explicitly authorized persistent-pilot operator with bounded allowlisted organizations/agents, a durable audit appropriate to post-write state, restart/stop controls, recovery from a tested pre-write backup, and safe cleanup policies. It must be proved against a separate isolated copy before any modification of the quarantined development cluster.
