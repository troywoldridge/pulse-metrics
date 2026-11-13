# Pulse Metrics — D15C-5E Operator Identity, Audit Custody and Alert Delivery Design

**Document status:** REVIEW ONLY. **Public launch: NO_GO.**

## Prior milestones and limits

- D15C-5A defined pinned, bounded SQL retention; D15C-5B rehearsed locking and concurrency.
- D15C-5C exercised a test-only operator over a disposable Unix-socket PostgreSQL cluster.
- D15C-5D produced a local SHA-256-linked journal and **alert candidates**, not sent alerts.
- This D15C-5E package implements **only an offline design contract and tests**.

**IMPORTANT:** Source-code conditions and JSON claims are not real identity verification, a signed release approval, an externally preserved audit trail, or successful alert delivery. The proposal validator *never* returns an operational authorization. A local SHA-256 chain can be forged again by an attacker who can rewrite all records; this project needs an independently controlled external anchor.

## Threat model and minimum release architecture

| Threat | Deployment control required before approval |
|---|---|
| Stolen maintenance credential | Dedicated nonhuman workload identity, short-lived credential, private endpoint, mTLS/TLS validation, tested revocation, narrowly scoped function EXECUTE; never share `pulse_metrics_app`, `postgres`, or migration credentials |
| Misuse of privileged cleanup | No direct DELETE, owner membership, DDL, schema creation, role assumption or tenant data SELECT; dedicated role, least-privilege grants verified by separate privileged audit |
| Unauthorized schedule or elevation | Two-person release/change approval, recorded owner, environment binding, auditable configuration deployment, explicit rollback and kill switch |
| A forged success message | Trusted scheduler exit status; signed/attested run identity, trusted log shipping, independent receipt retention; do not accept untrusted callers' success assertions |
| Lost audit records | Durable append-only external storage with independent access, encryption, replication, integrity-anchor checkpoints, limited retention and recovery procedure |
| Retry flood, silent alert loss | Durable outbox with deterministic idempotency key, bounded backoff/jitter, dead-letter review, delivery receipts, human escalation and acknowledgement evidence |
| Exposed operational secrets | Keep credentials, network routes, recipient addresses and tenant identifiers out of alert payloads; store secrets only in an approved secrets manager |
| Misleading backlog warning | `possibleBacklog` is a conservative signal, not an exact count of remaining rows; don't claim complete cleanup if SKIP LOCKED omitted records |

## Proposed maintenance principal (NOT created)

- Suggested **new** database login: `pulse_metrics_maintenance_runner` (design name only).
- Proposed credential: workload-managed, noninteractive, short-lived (maximum 60 minutes in offline proposal review), private TLS transport. Actual identity provider, rotation, attestation and DB authentication require platform decision and validation.
- Proposed grant: `USAGE` on the maintenance schema and `EXECUTE` of the *reviewed* bounded function only. Validate actual effective grants, including inherited roles and PUBLIC defaults, and inspect function definer/call chain.
- No direct DELETE, elevated membership, `BYPASSRLS`, broad schema rights, application role reuse, ownership or migration execution.
- Predeployment proof: explicit threat model approval, credentials/role inventory, test of forced revocation, transaction behavior, scheduler lock behavior, and deny-path audit.
- A self-declared configuration with `deploymentEnabled: false` is a *proposal*, not a signed or independently verified approval. The offline validator always returns `review_required` or `rejected`.

## Proposed alert handoff (NOT enabled)

1. Treat the validated D15C-5D audit receipt as an input **only after verifying the entire journal**. Even then, independently anchor custody before using it for operational guarantees.
2. Derive a deterministic idempotency key from the canonical audit-record hash, not a secret, host, tenant, or credential. The same receipt yields the same key; a rewritten/forged journal is not authentic merely because its hash matches.
3. A durable outbox transaction should persist the alert before any transport send. Prevent silent drop if journal write or outbox handoff fails. Define exactly which system owns the retry timer and state.
4. Deliver only a privacy-minimized envelope: version, idempotency key, fixed alert code and severity, audit reference, occurred time. Route/destination must come from a secured independent config store, not a user-supplied URI.
5. Use bounded attempts with exponential backoff and jitter; cap attempts; dead-letter and page humans when exhausted. Never automatically suppress a critical failure without independently authenticated acknowledgement.
6. Record transport response class, actual successful delivery and acknowledged operator receipt separately. A 202/200 response from a transport API is **not** proof a human read an alert.
7. Distinguish warning backlog, critical maintenance failure, critical protocol/configuration violation, overlap/no-alert, and no-work/no-alert.
8. Test network failures, rate limits, repeated messages, duplicate acknowledgements, lost outbox write, tampered journal, credential revocation, stuck scheduled run, failure to unlock, and replay attacks before production enablement.

## What this candidate actually tests

- Strict design-only operator proposal review; untrusted fields, credentials, privilege escalation and attempted deployment are rejected.
- Source-row shape, semantic classification and SHA-256 digest verification for **synthetic** D15C-5D records.
- Deterministic, sanitized alert **preview** idempotency keys, warning/critical priority and no-alert classification.
- Bounded retry/acknowledgement **decision previews**, never a send, retry scheduler or claimed delivery.
- Reuse of the existing D15C-5D local journal to exercise three synthetic audit records in an isolated `/tmp` directory. That journal is deleted at exit.

## Remaining release blockers

Real infrastructure is still unapproved: service identity provider; secrets custody; dedicated Postgres role and grant migration; private TLS authentication; immutable external audit sink; durable outbox; independent alert provider/receivers; acknowledgement and escalation ownership; redundancy, backup/PITR and disaster recovery; real production load and access tests; privacy and security signoff; scheduling; deployment runbooks. No real customer maintenance job should be enabled.

**D15C-5E is a review-only design milestone, not delivery or maintenance operations activation.**
