# Pulse Metrics — D15C-5I: Persistent Replay & Custody Boundary Design

**Security assessment:** REVIEW ONLY / `NO_GO` commercial launch.
**No database migration, grant, production identity, scheduler, remote transport or external storage activation.**

## Why this milestone exists

- D15C-5D: hash-linked local maintenance audit records and alert candidates.
- D15C-5E: proposed operator identity and alert policies, always `review_required`.
- D15C-5F: owner-only fake-receiver outbox, explicit retry and non-human transport receipts.
- D15C-5G: frozen local witness and manual-only recovery classification.
- D15C-5H: two distinct ephemeral Ed25519 identities for signed custody/decisions, with **in-memory** replay nonces.
- **D15C-5I**: one synthetic signature-consumption journal survives process restart; a different ephemeral signing key freezes the journal head for rollback-detection testing. All resources remain disposable.

## Proposed boundaries versus reality

| Boundary | Tested by 5I | Not yet achieved |
|---|---|---|
| Operator decision | Verifies prior 5H's signature, attestation, exact frozen alert membership | Real human identity, independent role authorization, revoked-user handling |
| Persistent replay rejection | Strict `0600` file, fsync, SHA-256-linked nonce/alert journal; second process rejects repeated decision | Multi-process shared transactional store, multi-node quorum, backup/PITR and authenticated writes |
| Append serialization | Owner-only `0700` exclusive directory lock, never steals stale locks | Multi-host lease/fencing with independently verified ownership |
| Evidence rollback | Separately signed, write-once **local** checkpoint detects changed or truncated replay journal | External WORM/append-only custody, key-service trust, witness freshness and retention |
| Recovery | Crash after fsynced write and before caller response; subsequent restart refuses reuse | Full real outage recovery, reconciliation after storage failure, quorum conflict resolution |
| Alert delivery | Still prohibited; ambiguous `in_flight` remains unchanged | Customer-safe production notifications and human-verified receipt/ack |

## Synthetic integrity contract

`synthetic-decisions.jsonl` stores one canonical JSON object per line. Each record includes `sequence`, `keyId`, `nonce`, `alertKey`, `decisionHash`, `attestationHash`, `outboxHash`, `recordedAt`, `previousHash` and `hash` plus an exact schema. Every append revalidates the prior chain, denies repeated `(keyId, nonce)` and repeated `alertKey`, uses a non-stealable lock, fsyncs the file and directory, and re-reads the complete chain. A crash leaving an incomplete line stops all future writes; no automatic repair or replay is attempted.

The independent-looking `frozen-replay-checkpoint.json` is a one-time detached-key Ed25519 signature over the ledger sequence/head and last decision hash. A verifying process receives **only pinned public key material**; a key supplied inside the checkpoint cannot appoint itself a trust anchor. The checkpoint is not reissued or overwritten as an automatic recovery action. A stale or missing checkpoint never authorizes resending an alert.

### Explicit negative outcomes

- Forged or extra-field decision: rejected before opening the ledger for append.
- Wrong trusted operator/custodian key: rejected.
- Outbox alert absent from the exact frozen snapshot: rejected.
- Repeated nonce or a different signed decision for the already-recorded alert: rejected.
- Missing, truncated, noncanonical, or altered ledger: rejected.
- Rewritten ledger with a recomputed valid SHA-256 chain: rejected by separately signed frozen checkpoint.
- Forged checkpoint, different signer public key, loose file modes, symlink/dangling symlink or stale lock: rejected.
- Process exit after fsynced append but before success acknowledgement: recorded nonce remains consumed in a new process.
- Production mode, database connection variables, external URLs and attempted operator/deployment activation: denied **before file or network activity**.

## Threat model and nonclaims

A malicious administrator sharing both stores and their signing-key custody can replace an entire local history; a test signature is no substitute for independent infrastructure. The first ledger write before its external checkpoint is especially exposed to rollback. The local file lock is process-private coordination, not a distributed lease. `fsync` on this machine cannot guarantee survival across all hardware failure or failover conditions. Nothing in D15C-5I grants cleanup privileges, authenticates a human, delivers an alert, accepts user-controlled destinations, or authorizes automatic retries.

## Requirements for a future release gate

1. A separate custodian principal, separate failure/security domain and externally verifiable immutable audit checkpoints; documented key storage, rotation, revocation and attested identity.
2. Atomic durable replay ledger enforcing uniqueness in a transactional database or equivalent, with independently audited privileges, backup/restore and rollback testing; signed decisions bound to an authorized current principal, key version, scope and expiry.
3. Source-of-truth reconciliation between audit journal, outbox, delivery provider receipts and human acknowledgements; never interpret HTTP `202`/`409` as a human response.
4. Independently authorized manual recovery transitions, dual-control for dangerous actions, emergency revocation and operational runbooks.
5. Separate threat modeling and real integration under least privilege; tested load, race conditions, secrets exposure, tenant boundaries, incident response and recovery points.

**Release: NO_GO.** These are future gates. D15C-5I does not assert or complete them.
