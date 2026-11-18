# Pulse Metrics — D15C-5U-2F2M Independent Signing Authority and Approval Trust

**Status:** Offline code candidate; verified against the archived 2F2I and 2F2J contracts, not deployed as operational authorization.

**Date reviewed:** 2026-11-17

**Launch / persistent telemetry status:** **NO_GO / NOT APPROVED**.

## Intent

2F2I proves an Ed25519 signature on a narrowly scoped, time-limited proposal **when the public key digest is supplied independently**. 2F2J/2F2K verify actual one-tenant owner and agent records in a disposable database. 2F2L proves a synthetic signed proposal can match that disposable identity evidence. **None of these stages establishes who is allowed to approve a real pilot.**

2F2M adds a *pure offline governance verifier* for three separate signatures:

1. A governance/root key signs a canonical trust roster containing signer and independent-reviewer public keys, role assignments, revocation states and an increasing serial number.
2. A rostered pilot-signing key signs the exact existing 2F2I review-only manifest.
3. A **different rostered reviewer key** countersigns the SHA-256 hash of that exact 2F2I envelope plus the hash and serial of the root-signed roster.

The root *public* key's SPKI SHA-256 fingerprint and minimum accepted roster serial are supplied **outside** the signed roster, from an independently authenticated operator record. The software cannot decide that a fingerprint or roster is trustworthy merely because it arrived in the same ZIP or JSON.

## Files added (complete, additive)

- `scripts/telemetry-persistent/pilot-trust-governance.mjs`: pure verification module, fixed review-only local target, no DB/network/filesystem/signing interfaces.
- `scripts/telemetry-persistent/pilot-trust-governance.test.mjs`: synthetic Ed25519 keys created only in isolated tests, with valid and invalid cases.
- `scripts/telemetry-persistent/review-pilot-trust-governance.mjs`: offline `--plan` and optional externally supplied artifact review, owner-only regular files; never prints identities, key material or signatures.
- `scripts/telemetry-persistent/run-pilot-trust-governance.sh`: SHA-locked offline test runner checking the original 2F2I and 2F2J modules.
- `README-D15C-5U-2F2M.md`: this document.

No existing source files, migration SQL, service configuration, PostgreSQL roles, or backups are rewritten by this package. There is no example signing private key, operational approval, or runtime activation entry point.

## Offline preflight

```bash
cd ~/Projects/pulse-metrics
bash scripts/telemetry-persistent/run-pilot-trust-governance.sh --plan

env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS \
    -u DATABASE_URL -u MIGRATION_DATABASE_URL \
  bash scripts/telemetry-persistent/run-pilot-trust-governance.sh --verify
```

Expected on the locked sources: 69 passing offline tests (2F2I + 2F2J + 2F2M), then `D15C-5U-2F2M OFFLINE TRUST GOVERNANCE: PASS` and **NO_GO**.

A future review with independently provided artifacts (not required for this milestone) would use:

```text
node scripts/telemetry-persistent/review-pilot-trust-governance.mjs \
  --review-offline /absolute/root-public.pem /absolute/root-signed-roster.json \
  /absolute/signed-2f2i-approval.json /absolute/reviewer-countersignature.json \
  <out-of-band-root-public-SPKI-SHA256> <out-of-band-minimum-roster-serial>
```

All four supplied files must be owner-only regular files with one link; neither the command nor this package generates private keys. **Do not fabricate or copy a fingerprint from the supplied roster and call it independent.** Real signing authorities have not been chosen or authorized.

## Fail-closed conditions tested

- Missing, substituted, malformed, or mismatched root public key and independently pinned root hash.
- Root-signed roster with mismatched fixed target, invalid validity window, invalid roles/keys, unexpected fields, duplicate IDs/fingerprints or wrong governance signature.
- Signed roster revoked signer/reviewer, key not yet valid, expired key, or key shared between governance, signer and reviewer roles.
- Roster serial below an independently known minimum; expired roster (maximum validity 24 hours).
- Altered pilot proposal, review decision, proposal hash, roster hash, serial, reviewer identity, review ID, signature, or review validity (maximum 60 minutes).
- Attempt to countersign with the pilot signer key rather than a separate reviewer key.
- A key not valid when the *claimed* proposal issuance/review occurred, even if it is valid now.
- Symlinked, non-owner, group-readable or oversized input files; arbitrary CLI flags; accidental disclosure in output.

## Limits — essential for a commercial SaaS

- **Distinct keys do not prove distinct people.** Signing-key custody, named reviewer assignment, separation of duties, and independent human review require documented operational controls.
- **A signature does not prove that a timestamp is true.** Signed `issuedAt`/`reviewedAt` values are caller-provided timestamps, not independent time attestations.
- **Offline checks cannot prove a roster is the most recent.** A 24-hour expiry and externally supplied minimum serial prevent some replay, but a new revocation could exist. Production must use an independently trusted, fresh revocation and monotonic-state source.
- **No binding to the protected 55433 cluster is made.** 2F2M does not start or connect to PostgreSQL. The 2F2H live audit remains empty-only, and the original protected database and retained cold backup must remain unchanged.
- **No real signer is authorized.** Trusted root bootstrap, secure offline key generation/custody, rotation, revocation publication, reviewer authentication, dual control, signed audit record, and disaster recovery procedures must be approved independently before any operational use.
- **No persistent writes or enrollment are approved.** Even a passed offline review returns `operationalAuthorization:false`, `liveDatabaseAttested:false`, and `realWorldSignerApproved:false`.

## Exit criteria

For this **offline** milestone: exact sources match, 69/69 tests pass, no existing files changed, no DB or real authority contacted, local checkpoint contains only five 2F2M files.

For later production readiness: a separate security review of the real root-of-trust and human authority approval, persisted signed audit trail, revocation freshness and rollback protection, safe agent authorization, independently tested backup/restore, and explicit operator approval. **Public launch remains NO_GO**.
