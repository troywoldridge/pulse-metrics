# Pulse Metrics — D15C-5F: Isolated Alert Handoff and Identity Boundary

**Security review only. Public SaaS launch: NO_GO.**

## Purpose and scope

D15C-5E established an **offline review contract** for operator identity, audit receipts and retry policy; it did not create a usable account or send alerts. D15C-5F goes one step further: it exercises a **real HTTP request** to a newly created **loopback-only fake receiver**. This is deliberately **not** production delivery. A separate, locally controlled, disposable random test secret authenticates traffic to that fake receiver. It is **not** a deployed workload identity, TLS credential, a PostgreSQL login or a customer-facing capability.

**No production environment may reuse the HTTP test transport.** The library hardcodes `127.0.0.1` and an internal test path, never reads a webhook URL, does not follow redirects, and never accesses a real database. Its executable integration test refuses `NODE_ENV=production`, `DATABASE_URL`, libpq overrides and missing explicit disposable authorization. It creates its own private `/tmp` directories, not paths chosen by the caller. No external alert provider, email, cloud service, service account, customer identity, or scheduler is enabled.

## Operational boundary being rehearsed

| Boundary | Evidence in this milestone | NOT demonstrated |
|---|---|---|
| Source provenance | Existing D15C-5D journal hash chain is verified before queueing; D15C-5E validates each receipt | Immutable or independently anchored evidence; adversarial source signer |
| Queue before send | 0600 atomic private outbox persist before `in_flight`, fsync file and directory | Crash-proof distributed outbox, cross-process transaction or HA durability |
| Local caller authentication | Ephemeral 32-byte HMAC secret and `timingSafeEqual` signature check, 30s freshness check | Real service identity, workload attestation, mutual TLS, credential rotation |
| Destination isolation | Receiver binds ephemeral port on IPv4 `127.0.0.1`; client hostname and path are hardcoded | External provider, private VPC routing, certificate trust |
| Retry discipline | Explicit step-by-step attempts, max three; `503`/`429` retryable; lock prevents concurrent test writers | Live scheduler, backoff with jitter, crash recovery, durable cross-node locks |
| Idempotency | D15C-5E deterministic receipt-derived key, queue dedup, simulated receiver `409` | Real provider idempotency SLA or exactly-once delivery |
| Acknowledgment | `202` means **only fake transport acceptance**; `409` means a simulated receiver duplicate | Human acknowledgement, escalation dispatch, delivery-to-recipient guarantee |
| Failure safety | Unknown status is protocol failure, explicit dead-letter; ambiguous in-flight attempt requires manual review | Real dead-letter storage and monitored escalation |
| Tamper handling | Symlinks, unsafe permissions, malformed local outbox and invalid source receipts rejected | An attacker controlling the directory cannot rewrite the whole outbox or chain |

## Outbox state machine (local test only)

`pending -> in_flight -> transport_accepted | receiver_duplicate | retry_pending | dead_letter`

- The `in_flight` state is **persisted and fsynced before each network attempt**. If the process dies before a result is durably recorded, the ambiguous in-flight record **cannot** be auto-retried. Manual review is required.
- `retry_pending` may be resumed **only** through another explicit test call. This package contains no retry timer. After three unsuccessful attempts, the record becomes `dead_letter` and cannot be attempted again.
- A permanent receiver rejection or unrecognized response goes directly to `dead_letter`. Authentication failures are never treated as successes.
- A local `202` is labelled `transport_accepted` and is **not** a human receipt or completed escalation. A `409` is `receiver_duplicate`, also not a human acknowledgement.
- The local private outbox is a **test artifact**, not a substitute for independently protected evidence. It is intentionally removed after the rehearsal, not retained as a production log.

## Test-only operator identity and transport

`reviewOperatorProposal` in the pinned 5E module always returns `review_required` or `rejected`, with `productionAuthorized: false`. 5F's identity boundary explicitly retains `realOperatorAuthenticated: false`. The HMAC secret is generated randomly in memory for the fake receiver and cleared on exit. Nothing grants `pulse_metrics_maintenance_runner` or any other PostgreSQL role. `PULSE_D15C5F_DISPOSABLE_ONLY=YES` is just a rehearsal guard, **not** a security credential or production approval.

The loopback receiver deliberately tests tampered/incorrect HMACs, a temporary failure followed by transport acceptance, repeated temporary failure to dead-letter, and a simulated duplicate. All messages contain only a fixed alert code, severity, sequence, hash and idempotency key; no customer IDs, machine credentials, destination email addresses, SQL text, or raw error strings are included in the handoff envelope.

## Required independent release work — no activation from 5F

1. Independently approved cloud workload identity and least-privilege dedicated DB role; credential custody and revocation testing.
2. A durable, independently controlled append-only audit sink with external integrity anchors, retention and recovery controls.
3. A transactional durable outbox connected to an approved production alert provider, tenant-safe routing and encrypted secret storage.
4. Genuine TLS endpoint identity, replay prevention, authenticated provider receipt and escalation/acknowledgement ownership.
5. Crash/partition recovery, actual backoff, poison-message handling, human paging and alert delivery monitoring.
6. Staging tests with access/abuse/availability review, backups/PITR and two-person activation approval.

**D15C-5F exit gate:** the offline + loopback tests must pass and the specific added files must be reviewed and committed separately. No public or scheduled service is authorized by this milestone.
