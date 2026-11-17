# Pulse Metrics — D15C-5U-2F2L: Signed Live Identity Binding, Synthetic Rehearsal

**Status:** Offline candidate. A real PostgreSQL 16 disposable run on `adap` has **not** yet been confirmed.

**Scope:** Reuse the exact pinned 2F2K one-tenant, pre-telemetry, disposable PostgreSQL rehearsal and, **in that same isolated server session**, stream the actual pinned 2F2J read-only SQL inventory to a synthetic Ed25519 contract review.

**Launch status:** `NO_GO`. No signing authority has been selected; no externally trusted approval key or manifest exists. The protected local development cluster on port `55433` remains strictly empty-only and must not be started by this rehearsal. No persistent writes or public access are authorized.

## Additive files

1. `scripts/telemetry-persistent/disposable-signed-live-binding.mjs` — strict JSON evidence reader, in-memory synthetic Ed25519 signer, comparison through the unchanged 2F2I and 2F2J validators, nine fail-closed signed/identity negative checks; no private key storage or disclosure.
2. `scripts/telemetry-persistent/disposable-signed-live-binding-stage.sh` — complete stage embedded **after** the exact existing 2F2K stage, reads SHA-pinned SQL via inherited file descriptor as read-only `psql` stdin, and pipes SQL stdout directly to the synthetic binder.
3. `scripts/telemetry-persistent/run-disposable-signed-live-binding.sh` — separate guarded operator; verifies all historical source hashes, the reviewed D15C-4B commit, normal environment, optional single-use disposable approval, and the original stop-and-delete cleanup marker. Generates a full temporary shell file instead of editing older scripts.
4. `scripts/telemetry-persistent/disposable-signed-live-binding.test.mjs` — 18 offline checks for strict evidence parsing, signature comparison, mismatch/refusal, sanitized CLI, unchanged cleanup and SQL boundaries.
5. `README-D15C-5U-2F2L.md` — this explanation.

The operator can additionally rerun the full 20 + 22 + 15 + 18 = **75 offline regression tests** from 2F2I through 2F2L.

## Essential distinction: simulated vs independently trusted approval

The synthetic rehearsal **does not possess an externally reviewed Ed25519 key**. It generates an ephemeral key pair in memory and computes the associated fingerprint **in the same process**, solely to exercise the cryptographic and identity verification functions. This self-pinned test-only fingerprint is never equivalent to the independently reviewed fingerprint required by a genuine 2F2I approval. Neither the private key, manifest nor database identity record is written to a file.

The synthetic 2F2I review manifest refers to the future **protected 55433** target as the original 2F2I contract specifies. The evidence comes only from the **disposable 55432** target as required by 2F2J. These are different targets intentionally. This exercise tests that a test-only signature and database-derived owner/organization/agent IDs **agree**, not that a real signer approved either target or that the protected target contains a tenant.

The 2F2J evidence validator explicitly returns `databaseAttested: false` and `operationalAuthorization: false` even for a valid signature. The external shell operator supplies provenance of the SQL stream through its pinned disposable PostgreSQL lifecycle. The JS module alone cannot attest database provenance, because a caller can supply synthetic JSON.

## Offline preflight (does not start PostgreSQL)

```bash
cd ~/Projects/pulse-metrics
bash scripts/telemetry-persistent/run-disposable-signed-live-binding.sh --plan
env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/run-disposable-signed-live-binding.sh --verify
```

`--verify` refuses any inherited launch approval. It checks the historical Git commit `78e6640`, pinned full original source, 2F2K fixtures and policies, and complete generation of the temporary 2F2K+2F2L runner. It does **not** start PostgreSQL.

## Separately approved disposable-only live rehearsal

Only **after** the offline preflight passes, verify stopped protected source and cold backup using the existing guarded verification commands. Then run the exact invocation:

```bash
PULSE_APPROVE_2F2L_DISPOSABLE=RUN_SYNTHETIC_SIGNATURE_AND_DESTROY \
  bash scripts/telemetry-persistent/run-disposable-signed-live-binding.sh --exercise-disposable
```

Run in a clean environment with inherited `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, and libpq redirect variables removed. The original D15C-4B lifecycle creates a fresh disposable PostgreSQL 16 cluster at `/tmp/pulse-replay-XXXXXXXXXX/data`, port `55432`, TCP disabled, and invokes the original mandatory cleanup trap. It must display all three exact lines:

```
========== D15C-5U-2F2K ONE-TENANT LIVE SQL REHEARSAL: PASS ==========
========== D15C-5U-2F2L LIVE SQL + TEST-ONLY SIGNATURE BINDING: PASS ==========
PASS: disposable quota PostgreSQL cluster removed
```

Only after those markers and a successful exit will the new operator output:

```
========== D15C-5U-2F2L SIGNED REHEARSAL + MANDATORY DESTRUCTION: PASS ==========
```

The protected 55433 source and retained backup must be reverified **after** this live exercise, even on failure. If an unknown disposable cluster remains active after an abnormal signal/forced kill, **stop and inspect it; do not manually delete directories or modify permissions**.

## Gate after this milestone

- Obtain truly independent authority selection, work-order review, verified WorkOS owner identity, and out-of-band signing public-key fingerprint review.
- Build an independently reviewed, persistent-target **read-only nonempty identity/telemetry inventory**, not a change to the empty-only 2F2H audit.
- Create fresh retained backup and independent restore evidence before any actual protected write.
- Explicitly authorize a separate scoped local-only nonzero pilot later, after tested recovery/rollback; never infer authorization from this test.

**No production ingress; no real enrollment; no persistent telemetry; public launch: `NO_GO`.**
