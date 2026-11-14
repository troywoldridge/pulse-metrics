# Pulse Metrics D15C-5J — Production Trust Boundaries and Release Evidence

**Document status:** REVIEW ONLY — architecture review and offline assertions
**Commercial public launch:** NO_GO
**Basis:** D15C-5C through D15C-5I security rehearsals; accepted ADR-001–009; commercial SaaS roadmap

## Boundaries at a glance

```text
CUSTOMER DEVICE                     CUSTOMER / OPS CONTROL PLANE
  signed outbound agent samples       authenticated user / operator identity
         |                                           |
         v                                           v
  trusted ingress gateway            organization authorization / separate ops RBAC
         |                                           |
         v                                           v
  scoped telemetry function          manual review (NO implicit replay)
         |                                           |
         +---------------+---------------------------+
                         |
                  PRIVATE POSTGRESQL
        tenant RLS | restricted roles | future outbox/nonce uniqueness
                         |
             restricted maintenance worker  [NOT ENABLED]
                         |
           independently controlled evidence writer
                         |
                 EXTERNAL CUSTODIAN STORE [NOT SELECTED]
                         |
                  independently pinned signed checkpoint
                         |
                 approved alert provider [NOT ENABLED]
```

The diagram describes desired relationships, not a deployed topology. Tenant trust and infrastructure-operator trust are **different**: customer organization roles do not grant database maintenance authority.

## Boundary inventory

| Caller -> resource | Independently established identity | Minimum permission | Never permitted |
|---|---|---|---|
| Browser -> API | Trusted, verified session + server-side organization membership | Only authorized customer resources | Browser-supplied tenant identity, direct SQL, shell/SSH |
| Agent -> ingest | Bound machine credential + verified ingress admission | Submit real, validated telemetry for bound agent | Broad query, impersonation, arbitrary process or command execution |
| API -> PostgreSQL | `pulse_metrics_app` as today | Existing restricted table/function grants + transaction-local verified tenant | DDL, BYPASSRLS, sensitive credential tables, maintenance function |
| Maintenance -> PostgreSQL | **New dedicated workload identity, proposed** | Exact reviewed bounded cleanup function only | App/migration role reuse, DELETE, DDL, tenant SELECT, role escalation |
| Custody writer -> evidence store | **Separately administered principal, proposed** | Append signed records with retention | Deletion, retention shortening, key/ACL management |
| Alert dispatcher -> provider | **Separate delivery identity, proposed** | Send minimised alerts to approved configured recipients | Dynamic user-supplied URL, secrets, account elevation |
| Human ops -> recovery decision | **Independent identity, current authorization and strong step-up, proposed** | Explicit review and dual-control for sensitive actions | Self-attestation, automatic ambiguous resend, client-chosen role |

## Integrity and recovery invariants

- A PostgreSQL transaction must commit event state and alert outbox intention atomically; publishing to a third party is a separate operation. A future dispatcher must support claimed-row fencing and idempotency without assuming exactly-once delivery.
- Uniqueness keys: `(signing_principal_id, decision_nonce)` and alert idempotency identity, with defined behavior for changing operator keys, revocation and time windows. SQL privileges must make bypass via raw mutation impossible for ordinary workers.
- Durable `in_flight` is not automatically `queued` on restart. Reconciliation asks: what was queued, claimed, accepted, duplicated, acknowledged by a human, or left unknown? Unknown stays quarantined until authorized review.
- An independent evidence store must make it possible to detect a missing or rewritten chain *after* external anchoring. A cryptographic hash without independent retention can still be recomputed by an attacker who controls its entire source.
- Receipt semantics: provider accepted != endpoint delivered != authenticated human acknowledged. Operator acknowledgement must bind current verified identity, scope, decision, alert, custody head, unique nonce and expiry. Every revocation path fails closed.
- Incident shutdown and stolen-key rotation are part of the control design, not optional administrative polish. The maintenance path should be disabled during custody or identity verification failures, subject to an independently approved incident runbook.

## Open architectural decisions (must be owned and documented)

1. Hosting platform and private ingress/egress network topology; identity federation capabilities and credential rotation.
2. Custody platform and distinct administration/account boundary; WORM/retention mode, privacy/legal retention, encryption, key control and cross-region failure recovery.
3. Real user/operator identity provider and separate ops RBAC/step-up/two-person approval workflow.
4. PostgreSQL schema for outbox, nonce and claims; isolation from tenant data; migration/rollback, owner role and function grants.
5. Alert provider and allowed destinations; rate limits, escalation, delivery receipts and human acknowledgement semantics.
6. Recovery targets (RPO/RTO), service-level objectives, monitoring and periodic independently observed restore drills.

## Release evidence register

`docs/security/D15C-5J-RELEASE-GATE-REGISTER.json` is a **deliberately unverified** machine-readable inventory. All sixteen gates remain `external_verification_required` with null evidence and reviewer. The D15C-5J checker only accepts this review state. Adding an `approved` string to JSON can never make the checker authorize production. Separate release authority, independently obtained evidence and signed change approval are required in a **future** operational process.

## Threats the 5J tests cover (design-contract scope)

- A candidate blueprint that shares an API or migration role with privileged cleanup, enables maintenance, pretends to select a cloud or supplies unexpected secrets is rejected.
- A self-declared `passed` gate, missing gate, repeated gate, extra key, fake evidence or fake reviewer is rejected rather than counted as verification.
- Attempted `automatic_retry`, `send_again`, `mark_human_acknowledged`, `grant_database_role` or `approve_production` has no execution path.
- Unknown and `in_flight` states require manual reconciliation and cannot silently become safe-to-replay.
- Production environment, PostgreSQL connection overrides, outgoing URL configuration or arguments prevent even the offline demonstration from starting.

## Required real-world negative tests after architecture acceptance

- Concurrent database writers from separate workers with unique constraints, race contention, transaction rollback and recovery from arbitrary process death.
- Revoked short-lived workload identity, failed TLS hostname, inherited PUBLIC grants, privileged function ownership, migration identity misuse and role escalation attempts.
- Cross-organization control/telemetry leakage and browser-supplied identity spoofing against real authenticated routes.
- Custody principal compromise, WORM deletion/retention-bypass attempts, gap detection, independent key rotation/revocation, missing receipts and backup/restore rollback.
- Authenticated operator step-up, revoked session, wrong permissions, stale approval, second-approver conflict, forged receipts, concurrent duplicate nonce and mixed tenant contexts.
- Provider failures, delayed acknowledgement, duplicate deliveries, dead-letter overflow, ambiguous transmission and manual reconciliation after a crash.
- Loss of a database region, queue worker, key management provider or evidence store; monitored failure, kill switch and independently reviewed recovery drills.

## Reference documentation used for design review

- PostgreSQL 16 TLS / libpq host identity verification: https://www.postgresql.org/docs/16/libpq-ssl.html
- PostgreSQL 16 libpq connection settings: https://www.postgresql.org/docs/16/libpq-connect.html
- AWS S3 Object Lock design option (not a selected vendor): https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html
- AWS temporary workload roles design option (not a selected vendor): https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html

These references describe capabilities only. Provider configuration, permissions, custody independence and actual operational evidence have **not** been verified for Pulse Metrics.

**5J completion is an architecture-review checkpoint. Public launch is NO_GO.**
