# Pulse Metrics — D15C-5G Recovery Evidence & Frozen Local Witness

**Decision state: REVIEW ONLY. Public launch: NO_GO.**

## Why this milestone exists

D15C-5D proved a private, locally hash-linked audit journal and alert candidates.
D15C-5E proposed dedicated operator identity and delivery contracts, explicitly
without granting access. D15C-5F exercised an isolated fake receiver and 0600
outbox with intentional ambiguity protection for interrupted `in_flight` sends.

D15C-5G tests **forensic recovery review**, not unattended crash recovery. It
creates one *additional*, separate, frozen local witness document linking the
entire 5D journal head, sequence and complete 5F outbox snapshot. That snapshot
can detect local history rollback, rewritten journal chains and outbox changes
*relative to the frozen witness*. The witness is owned by the same local test
user and stored on the same test computer; it is **not a genuine independently
controlled external audit anchor**, security signature, WORM storage or backup.
A malicious user with the ability to rewrite the entire local evidence set
may replace the witness too. Independent off-machine custody remains required.

## Recovery states, each requiring explicit review

| 5F durable status | 5G consequence | Unsafe implication prohibited |
|---|---|---|
| `pending` | Manual queue review | Do not silently send |
| `in_flight` | Ambiguous send; manual receiver reconciliation | No automatic replay after process restart |
| `retry_pending` | Manual bounded retry assessment | No background retry timer |
| `transport_accepted` | Review receipt / seek human acknowledgement independently | HTTP 202 is not human acknowledgement |
| `receiver_duplicate` | Review idempotent receipt and actual operator evidence | HTTP 409 is not human acknowledgement |
| `dead_letter` | Manual escalation, remediation and case ownership | Never drop failed alerts silently |
| Missing eligible outbox alert | Explicit count to investigate | Never fabricate a send or backfill automatically |

Cross-check the *whole* local audit journal using the D15C-5D verifier and
D15C-5E audit-receipt contract. Derive expected alert idempotency keys from the
original SHA-256 record and compare each 5F outbox entry's key, audit hash,
sequence, code and severity. A missing entry is a counted review issue;
foreign, malformed or impersonated outbox rows fail closed.

## Local witness and crash security

The local witness is a 0600 file inside a separate, owned 0700 directory with
its own owner-only marker. Its creation requires `O_EXCL` and no-follow checks;
there is no automatic update, overwrite or re-anchor. It binds:

- the full journal's last hash and exact record count;
- a canonical hash of the complete 5F outbox snapshot and entry count;
- the number of eligible alert receipts missing from the outbox;
- a timestamp and a SHA-256 digest of the witness body.

It is written and synced before presenting the plan. An immutable claim is
**not** made: its integrity and custody remain limited to its local owner.
Production operators need an independently owned, access-controlled external
checkpoint, signatures or appropriately authenticated append-only custody,
retention, key rotation, backups and recovery drills. Local SHA-256 is not
proof of who wrote an event.

Test invocation holds both the existing 5D and 5F local writer locks before
freezing; it refuses stale/missing/invalid witness files. A subprocess with
fresh JavaScript memory verifies the frozen evidence and proves that
`beginLocalAttempt()` still refuses an ambiguous `in_flight` message. A crash
leaving a lock requires deliberate inspection; tests do not steal stale locks.
No real maintenance or notification operation occurs.

## Identity, acknowledgement and escalation boundaries

No caller's `humanAcknowledged: true` claim can be added to a 5F record: the
strict outbox schema rejects additional fields. 5G returns
`humanAcknowledgementVerified: false` and `automaticReplayAuthorized: false`
for *all* states, regardless of HTTP 202 or 409, and even when the local
witness is coherent. There is **no authenticated human acknowledgement**.
The offline policy returns only counts, a fixed review decision and booleans,
not source rows, paths, tokens, emails, tenant IDs or transport diagnostics.

A future independently reviewed release needs:

1. Workload identity issuance, key custody and revocation tested against a
   staging database with explicit least privilege and a private TLS endpoint.
2. Externally controlled and authenticated audit witness/anchor storage,
   preservation of run start/failure outcomes, independent receipt logging,
   off-site retention and backup recovery tests.
3. A durable operator escalation queue with authenticated human ownership,
   timed escalation, acknowledgement freshness, replay resistance, idempotency
   and on-call operational runbooks.
4. Explicit criteria for handling stuck `in_flight` sends: consult trusted
   destination receipts before any authorized retry, and otherwise preserve
   ambiguity rather than inventing safe replay.
5. Disaster recovery exercises (power loss, filesystems, incomplete write,
   old snapshots, restored backups, key loss and network partitions),
   SLA/SLO, RPO/RTO, monitoring and independent security review.
6. A separate two-person release approval for real alerts or scheduled
   maintenance. **Current public launch is NO_GO.**

## Explicitly out of scope

No PostgreSQL access, migration, pg_hba change, agent permission, production
operator, real webhook, outbound HTTP, SMTP, background timer, live alert,
customer data, or real human acknowledgement is created. This is deliberately
an *offline* recovery evidence and tamper-detection review milestone.

**D15C-5G is not a production activation milestone.**
