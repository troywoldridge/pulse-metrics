# ADR-010 — Production Maintenance, Audit Custody and Replay Trust Boundaries

**Decision date:** 2026-11-14
**Status:** PROPOSED — not accepted, provisioned or activated
**Decision authority:** Requires explicit owner/security and deployment-platform review
**Related accepted decisions:** ADR-001 through ADR-009 in `ARCHITECTURE-DECISIONS.md`
**Public launch:** NO_GO

## Context

Pulse Metrics is a commercial, multi-tenant infrastructure monitoring platform. Its previous 5C–5I milestones exercised bounded maintenance, local hash-linked audit records, isolated alert delivery, frozen witnesses, test-key signatures, and durable local nonce replay rejection. Those tests establish useful invariants but **do not establish** a production workload identity, independently administered custody, multi-worker transactionality, verified humans, or infrastructure deployment.

The current product direction requires PostgreSQL, least privilege, strong tenant isolation, outbound authenticated agents, and incremental infrastructure. D15C-5J is an architecture and evidence-gate review only. Existing runtime and migration roles (`pulse_metrics_app`, `pulse_metrics_migrator`) remain separate. No previously reviewed migration should be edited.

## Recommended design, subject to acceptance

1. **Separate workload principals.** Independent workload identities for customer-facing API, telemetry ingress, restricted maintenance runner, evidence custodian and alert dispatcher; no principal obtains the other's database grants or signing keys. The maintenance login, provisioned later under a separate reviewed change, has only the exact bounded maintenance function EXECUTE (and necessary namespace access). It must never reuse the application, migration or PostgreSQL superuser role, own tenant tables, bypass RLS, or receive direct DELETE, DDL, role membership or unrestricted query privileges.
2. **Private authenticated database connection.** Maintenance and API database access stay on approved private networks. For TCP PostgreSQL, require certificate/hostname verification (`sslmode=verify-full`) and independently verified client/workload identity. The authentication mechanism (cloud IAM database auth, short-lived client certificates, or approved credential broker), cloud platform, revocation and rotation procedure are **not selected yet**. Unix-domain-socket ephemeral test connections cannot prove production network security.
3. **PostgreSQL transactional state before new infrastructure.** The first shared outbox, decision nonce uniqueness, alert identity uniqueness, and worker claims should be in the existing PostgreSQL stack. A future separately reviewed migration should define durable uniqueness, atomic business-event/outbox writes, constrained transition rules, `FOR UPDATE SKIP LOCKED` or equivalent safe claims, fencing/expiry and database privilege boundaries. A local file lock and fsync are not multi-host consistency. Do not add Redis or Kubernetes solely for this workflow without demonstrated need.
4. **Independently held custody.** An evidence writer may append only signed, privacy-minimized receipts to a versioned, retention-protected object store in a separately administered security account/domain. No maintenance, application, or dispatcher identity can delete, shorten retention, change ownership, replace trusted keys or disable monitoring. A witness must include stable object version identifiers and a chain head, with externally controlled signing keys and independently verifiable continuity. Candidate technology: S3 Object Lock with versioning and separately controlled access, contingent on choosing AWS; alternatives must meet equivalent independent retention, access and recovery controls. Versioning/retention alone do not prove receipt completeness or human acknowledgement.
5. **Human authorization is separate.** Operator login/session and strong step-up verification derive from the trusted identity provider, not a signature embedded in the alert. Current role/permission, revocation, scope, nonce/expiry, approver separation, and high-risk two-person authorization are checked server-side before any sensitive action. Customer organization administrators are not automatically infrastructure maintenance operators.
6. **Keep ambiguity blocked.** An `in_flight` send after a crash has unknown outcome; never infer safe automatic replay. A provider `202` or duplicate `409` response is transport evidence, not proof that a human saw or acknowledged it. Reconciliation and any repeat send require separate authorization and durable decision evidence, after a future risk review.
7. **Controlled deployment.** Production security changes require independent code review, threat model signoff, documented rollback, monitoring, incident response, an emergency shutdown path, tested encrypted backup/PITR/restore and explicit approval. The 5J artifacts cannot activate any of these.

## Alternatives considered

| Option | Assessment |
|---|---|
| Continue with local SHA journals and local witness | Rejected for production: same-host compromise can rewrite history and locks are not distributed |
| Put nonce decisions and alert outbox in PostgreSQL | Proposed initial path: aligns with existing stack; transaction/constraint and role design still unimplemented |
| Add Redis-based distributed locks first | Deferred: introduces extra data durability and privilege boundaries without demonstrated requirement |
| Use a managed queue and transactional outbox | Possible later extension; must explicitly solve publish/commit gaps, receipt idempotency and replay controls |
| Share application DB role with maintenance | Rejected: defeats least privilege and creates unnecessary tenant/data access |
| Put custody in the same account/principal as maintenance | Rejected: weak independent evidence guarantees |
| Select a specific cloud or retention duration today | Deferred until hosting, legal/privacy retention, operational cost and restore requirements are reviewed |

## Required evidence before status can change

See `docs/security/D15C-5J-RELEASE-GATE-REGISTER.json` for sixteen **unverified** requirements. A developer-edited status or self-reported provider receipt is **not** a production approval. Each gate needs documented independent evidence, an identified accountable reviewer, a dated approval with traceable change control and negative tests. The software in this milestone always returns `NO_GO` even for its proposed architecture blueprint.

## Consequences and follow-up milestones

- **5J:** Design recommendation, trust-boundary inventory, release register and fail-closed tests. Nothing goes live.
- **Future review:** Select hosting and custody provider, service identity strategy, operator authorization model and retention; obtain explicit architectural acceptance before schema changes.
- **Separate future implementation:** Dedicated least-privilege database grant migration, transactional outbox/nonce schema, restricted worker, external custody, key lifecycle, identity and acknowledgement verification, integration and disaster-recovery drills.
- Preserve the immutable historical migrations and source pins. Never equate a local proof with production authorization.

**This ADR is a recommendation for review, not permission to deploy.**
