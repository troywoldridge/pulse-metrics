# Pulse Metrics — D15C-5H Signed Custody and Operator Decisions

**Design state:** Review-only synthetic trust-boundary test.  
**Public SaaS launch:** **NO_GO**.  
**Predecessor:** D15C-5G frozen *local* witness and manual recovery review.

## Intended result

Prove the shape of two independent cryptographic trust assertions without
claiming any real external audit retention, service identity, authorized human,
workload signing service, delivery or production access.

- **Custodian assertion:** a detached Ed25519 signature over the full, checked
  D15C-5G witness's identity (witness hash, audit head and sequence, outbox
  digest/count and missing-outbox count). Validation requires an **independently
  passed, trusted public key**. It never accepts a public key from the signed
  receipt itself as its source of trust.
- **Operator decision:** a *different* Ed25519 key signs an explicit decision
  bound to the already verified custodian attestation and ONE alert's key,
  audit hash and audit sequence. The verifier additionally requires an exact
  matching row within the *entire* checked frozen outbox snapshot, with the
  snapshot hash matching the signed witness. The only accepted synthetic decisions are
  `review_no_replay` and `escalate_no_replay`.
- **Replay check:** a supplied nonce Set rejects a second use within the same
  verifier lifetime. This is NOT persistent replay protection. A durable
  independently controlled replay ledger is a mandatory next prerequisite.
- **Cross-process verifier:** the offline demo spawns a fresh verifier Node
  process, passing only detached signatures, fixture data and public keys.
  The private keys are not sent to the child.
- **Input restrictions:** exact object shapes, canonical signatures, temporal
  checks, key types, public key identifiers and source-witness integrity.
  Unrecognized decisions, key swaps, changed alert bindings, altered audit
  histories, and untrusted or missing public keys fail closed.

## What is *not* established by these tests

The two ephemeral private keys are generated in a single disposable developer
process. Their public keys are temporarily pinned by the rehearsal. Thus they
are **not independently administered, externally anchored or isolated against
compromise of that parent process**. Ed25519 confirms the receipt matches a
specific key, not that a real authorized custodian or human controlled it.

The D15C-5G audit witness is another local file owned by the same test user.
The signed attestation does not make that source externally immutable. No
private key is persisted, provisioned, rotated or handed to a real service.
The local test nonce Set cannot survive a restart and is not a production
acknowledgement ledger. An accepted **synthetic** operator decision does NOT
mean a human viewed, understood, or approved the event.

No real application identity or permissions, PostgreSQL service, migration,
SSH, external HTTP endpoint, webhook, email transport, scheduler, secret
manager, deployment configuration or customer data is used.

## Required production-stage architecture (not implemented)

1. Choose a genuine independent, access-controlled audit custodian service,
   with append-only/WORM retention policy, identity separation, encryption,
   access review and externally controlled continuity checkpoints. Test
   deletion, rollback, full rewrite and restore from backup.
2. Manage attestation keys in independent KMS/HSM custody. Pin/verifiably
   distribute trusted signing keys through a separately approved path; test
   rotation, revocation, stale keys and compromised-key recovery.
3. Bind maintenance and alert decisions to verified operator IAM identity,
   scoped role, org/tenant context where appropriate, allowed operations,
   strong authentication and explicit authorization with independent approvals.
4. Persist a strict, transactional, append-only acknowledgement/outbox ledger
   and nonce/idempotency index. Authenticate receipts and disallow replay after
   crashes and across instances. Test concurrent duplicate attempts.
5. Keep the recovery invariant: interrupted `in_flight` delivery is ambiguous.
   A signed decision is an auditable human-review input, **never** an implicit
   permission to retry an ambiguous send or change a delivery state.
6. Route alerts through an approved provider using controlled destination
   configuration, delivery status semantics, dead-letter operations and
   separately verified human acknowledgement. Test outages and escalation.
7. Introduce deployment grants, scheduler and real identities only in
   separate authorized milestones with production risk review, rollback,
   backup/PITR and tenant-isolation evidence.

## Acceptance evidence for this exit

- Source hashes of the six new files match a reviewed 5H verifier.
- 5D/5E/5F/5G review-source hashes still match.
- Local unit tests prove strict fail-closed semantics; a real local fixture
  uses existing 5D–5G libraries for the journal, outbox and frozen witness.
- Fresh verifier process confirms separate detached signatures; signature
  replay is rejected within the explicitly scoped in-memory ledger.
- Altered source and recomputed local witness are rejected; no live
  authorization, delivery, automatic replay or human-acknowledgement claims.
- Both happy-path and unsafe-config rejection tests are complete on Troy's
  workstation before a GitHub milestone commit.

**Production launch remains NO_GO.**
