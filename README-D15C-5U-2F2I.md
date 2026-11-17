# Pulse Metrics — D15C-5U-2F2I: Independently Signed Pilot Identity Manifest

**Status:** Review-only candidate; offline validation required on the owner workstation.
**Scope:** A single explicitly approved organization, owner user, enrolled agent and limited sample count.
**Launch:** `NO_GO`. This package cannot enroll an agent, start PostgreSQL, or authorize writes.

## Why this milestone exists

2F2F proved real tenant-isolated telemetry persisted across a **disposable** database restart. 2F2G proved a guarded start/audit/stop of the quarantined **empty** local database. 2F2H proved a real read-only **empty** PostgreSQL inventory under its existing locked SQL adapter.

2F2I introduces a *separate approval artifact* whose tenant identities and bounds are not inferred from the database being audited. An Ed25519 signature can protect the approved proposal against modification, but a signature is trusted only after independently reviewing and pinning the approval key's SHA-256 SPKI fingerprint. No signing authority is established by installing this package.

## Added files

- `scripts/telemetry-persistent/pilot-authorization-policy.mjs`: canonical JSON, exact one-agent identity, fixed private PostgreSQL target, 24-hour time limit, Ed25519 signature and independent key-fingerprint checks, and restricted 2F2G fixture policy evaluation.
- `scripts/telemetry-persistent/review-pilot-authorization.mjs`: offline-only CLI with `--plan`, `--check-draft ABSOLUTE_PATH` and `--review-signed-offline ABSOLUTE_ENVELOPE ABSOLUTE_PUBLIC_PEM INDEPENDENT_SHA256`. No signing or activation commands exist.
- `scripts/telemetry-persistent/pilot-authorization-policy.test.mjs`: genuine Ed25519 signature, expiry, forged tenant, mismatched inventory, noncanonical and trust-anchor-negative tests.

These are **new complete files**. None replace the existing 2F2G or 2F2H operators, production routes, migration SQL, credentials or backup scripts.

## Approval contract

The canonical signed manifest has exact fields:

- `version: 1`, `purpose: "pulse-metrics-2f2i-pilot-review-only"`, `environment: "isolated-local-development"`.
- `target`: exact local database `pulse_metrics`, original data directory and private Unix socket, port `55433`, no TCP.
- `ownerUserId`: independently identified UUIDv4; no owner identity inferred from database rows.
- `policy`: the existing 2F2G bounded structure, `organizationId`, `agentId`, `expectedSamplesMin`, `expectedSamplesMax` (capped at 100), `agentStatus: "active"`.
- `approval`: review ticket, reviewer identifier, and `independentReview: "required-outside-database"`.
- `issuedAt`, `expiresAt`: canonical UTC timestamps with a positive lifetime of at most 24 hours.

The detached signature is 64-byte Ed25519 over domain-separated canonical JSON. The canonical signed-envelope format is `{"format":"pulse-metrics/2f2i/ed25519-v1","manifest":{...},"signature":"..."}` with all object keys sorted lexicographically and no insignificant whitespace or duplicate keys.

The public key is checked against an **independently supplied, reviewed SHA-256 of SPKI DER**. Supplying a key and matching its own digest is *not* independent approval; the approver must attest this digest through a trusted, separate channel. This package installs **no approved key or approval manifest** and never creates or stores private keys.

## Local commands

```bash
cd ~/Projects/pulse-metrics
node --check scripts/telemetry-persistent/pilot-authorization-policy.mjs
node --check scripts/telemetry-persistent/review-pilot-authorization.mjs
node --test scripts/telemetry-persistent/pilot-authorization-policy.test.mjs
node scripts/telemetry-persistent/review-pilot-authorization.mjs --plan
```

The optional draft and signed-review modes require operator-created **absolute paths** to files outside the repository; they do not create files. No real owner/organization/agent identities are included in this package. The test identities and signing keys are **ephemeral synthetic fixtures**, not retained or authorized customers.

## Strict blockers before the first retained Linux telemetry write

1. Complete out-of-band identity review: verified owner user, independently selected organization and preallocated agent UUIDs, membership binding, change-control approval and trust-anchor key ceremony.
2. Extend the reviewed read-only PostgreSQL adapter to return owner membership facts and verify the live bounded tenant/agent identity. The existing 2F2H adapter is **empty-only** and MUST NOT be modified to permit nonzero rows.
3. Implement separate nonzero-database start, audit, stop and restore procedures: the current operator intentionally refuses nonzero rows. Check fresh backups and independent restore before any write or restart.
4. Test onboarding, credential rotation/revocation, exact quotas and telemetry persistence in a disposable pilot, including attacks against cross-tenant access, compromised credentials, and rollback.
5. Explicitly authorize a bounded, local-only first write in a *later* independently reviewed milestone. No production ingress or launch may be enabled here.

**2F2I completion means the approval artifact and negative tests passed offline. It does not mean an approval was issued, a pilot was admitted, or production is ready.**
