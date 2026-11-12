# Pulse Metrics — Phase 2E3C5D5: Production readiness gap audit

**Audit date:** 2026-11-12
**GitHub branch:** `feat/identity-organization-onboarding`
**Reviewed commit:** `f9095d6bcef8428ee877ca2892614146e753ff26` (`test(database): verify release failure recovery and retry safeguards`)
**Decision:** **NO-GO for public launch and live customer onboarding.**
**Scope:** Source review of the committed GitHub tree; uploaded product roadmap and security/project documents; and the latest user-supplied local test transcript. **Not** a penetration test, production infrastructure inspection, legal review, vendor assessment or proof of operational deployment.

## Executive conclusion

Pulse Metrics has a substantial **locally tested database-security and operational-rehearsal foundation**. The November 12 run recorded 14/14 recovery decisions, 10/10 release approval policy cases, 5/5 privileged migration manifest cases, 183/183 application unit cases, and successful TypeScript/build/Drizzle checks. A disposable PostgreSQL cluster successfully exercised `pg_terminate_backend`, rollback, advisory lock release and reconcile-before-retry logic. Other preceding synthetic-only tests demonstrated database restore and second-cluster role recovery.

**These results do not establish a working commercial monitoring service.** The same committed tree still contains the original simulation-oriented monitoring implementation and arbitrary command-execution code. Its WebSocket upgrade handler currently rejects every connection (`403`), and the legacy collector's start call is commented out. The first genuine Linux telemetry agent is tested but logs samples **only to its local terminal**. There is no reviewed, mounted authenticated agent telemetry ingestion endpoint in the inspected Express entrypoint, and customer live/historical monitoring APIs intentionally return an authorization-pending response. This is fail-closed for now, but not useful customer monitoring functionality.

**Recommendation:** Complete a controlled legacy-code retirement next, keeping the WebSocket denial and unavailable monitoring APIs in place until the replacement authenticates and authorizes tenant-scoped telemetry. Build secure enrollment and ingestion, then connect authorized dashboard views. Run additional production security and operations gates afterward.

## Evidence classifications

- **VERIFIED LOCAL TEST** — user-submitted command output for explicitly named test cases; does not imply production behavior.
- **OBSERVED IN SOURCE** — directly examined code, without asserting an integrated feature works.
- **CONTROL CURRENTLY PRESENT** — observed blocking/defensive behavior, to preserve during migration.
- **PENDING / NOT EVIDENCED** — necessary production end-to-end evidence not shown by the reviewed material. This **does not** prove functionality cannot exist outside the reviewed tree.
- **BLOCKER** — public launch requires remediation and independent verification.

## Launch gates and evidence matrix

| Gate | Status | Basis and specific limitation | Exit/acceptance evidence required |
|---|---|---|---|
| PostgreSQL isolation / RLS | VERIFIED LOCAL TEST; production PENDING | Nov 12 audit shows 10 tables with forced RLS, restricted runtime role, 6 security functions; previous tenant-context integration is recorded. No customer production acceptance test. | Role/RLS review in production-like environment; cross-tenant negative tests for **all** exposed resources and WebSockets. |
| Fresh SQL migrations / immutable receipts | VERIFIED LOCAL TEST | Privileged manifest 5/5, six reviewed steps, read-only live baseline; Drizzle remains unchanged. | Release promotion, migration identity, backup/approval and rollback gates executed in staging. |
| Synthetic backup and independent-cluster restore | VERIFIED LOCAL TEST | Earlier 2E3C5D1/D2 success, including roles and synthetic data. Same-machine test without real secrets or production volumes. | Encrypted/offsite backup restoration, independent credential recovery, WAL/PITR design and tested RPO/RTO. |
| Release locks / approvals / failure recovery | VERIFIED LOCAL TEST | 2E3C5D3/D4 signed **ephemeral test** approvals, session lock, transaction rollback, receipt reconciliation. | Real distinct operator identities, key custody/revocation, protected independent audit, production release runner, failure/rollback drill. |
| WorkOS-backed human API identity | OBSERVED IN SOURCE; production PENDING | `server.ts:33-46` mounts verified identity and organization routes; `src/main.tsx` mounts AuthKit; unit tests cover failures. Not a complete browser/session lifecycle or deployment configuration review. | Staging end-to-end auth, logout/session revocation, role/membership isolation, organization UI flow and audit. |
| Agent enrollment and machine identity | **BLOCKER** | DB schemas/credential security exist; no independently verified enrollment/rotation/revocation and bound agent communication is demonstrated. | One-time hashed tokens; agent credential issue/rotate/revoke; replay/impersonation and cross-org abuse tests. |
| Authenticated telemetry ingestion | **BLOCKER** | `src/agent/run-linux-agent.ts:50,109` explicitly logs telemetry locally; inspected `server.ts` mounts no authenticated ingestion route. | Versioned endpoint validates agent credential, organization, payload, timestamps, limits, idempotency, persistence and failures. |
| Real Linux collector | OBSERVED IN SOURCE; partial local test | `src/agent/linux-collector.ts` reads OS counters, samples tested; collector is distinct from the inactive legacy dashboard path. | Linux device integration, sampled CPU/memory/disk/network comparisons, freshness/offline/error semantics and resource-limit tests. |
| Legacy arbitrary shell/SSH | **BLOCKER before public launch**, currently unreachable through WS | `server.ts:642-673` still handles `exec_ssh` with `exec(fullCommand,...)`; `src/App.tsx` still wires `SshTerminalDrawer`. `server.ts:53-58` rejects every WebSocket upgrade. | Remove legacy handlers/UI imports and SSH host assumptions **end-to-end**; regression-test no command execution, no unsafe WS upgrades and no public history data. |
| Fabricated telemetry and history | **BLOCKER** | `server.ts` contains `Math.random`-based metrics and hardcoded `work-server`; `src/server/historical-store.ts` generates historical points; legacy `startCollector()` is disabled (`server.ts:588-590`). | Remove/clearly label all mock data; use only authenticated persisted real measurements with explicit unavailable states. |
| Tenant-safe live/historical dashboard | **BLOCKER** | `server.ts:47-50` rejects unimplemented API requests with 503; `server.ts:53-58` rejects upgrades; `src/App.tsx` attempts WebSocket subscriptions. | Authenticated tenant-scoped APIs/streams and persisted history, websocket ticket/subscription authorization, stale/offline/error UX and end-to-end isolation. |
| Alerts and reports | PENDING | Planned roadmap phase; no supported operational evidence of real alert pipeline. | Agree MVP scope, test alert evaluation/notification lifecycle if required for launch. |
| Billing / subscription limits | **BLOCKER for paid public SaaS** | Pricing, checkout, webhook authenticity/idempotency and plan restrictions are not demonstrated by reviewed route and tests. | Implement provider lifecycle, signed webhook verification, limits, failure and cancellation tests. |
| Production transport, secrets and network hardening | **BLOCKER** | No production target/environment inspected. Local peer Unix-socket tests are not TLS, DNS, certificate, secret rotation or deployment proofs. | Approved topology, TLS/mTLS as applicable, secure proxy/headers, credential storage/rotation, network and log reviews. |
| Operations, privacy and support | **BLOCKER** | Roadmap and release checklist require retention/deletion, monitoring, incident response, backup, customer support and policy/legal reviews; not verified in production. | Written and exercised runbooks, observability, retention/deletion, support/privacy/terms, load testing, on-call and vulnerability response. |
| Dependency security / supply chain | PENDING | Build succeeds, but that is not a reviewed dependency audit or artifact provenance/CI gate. | Lockfile, SBOM/dependency review, secret scanning, signed release artifact or equivalent release attestation, update policy. |
| Project handover documentation | **DOCUMENTATION DRIFT** | `docs/project/CURRENT-STATUS.md` and repository README still describe WorkOS integration as not implemented, despite mounted auth code and tests; their branch/phase data is stale. | Rewrite those **whole files** from reviewed evidence in a subsequent approved documentation step; do not mark incomplete features done. |

## Immediate priority order

### P0 — Phase 2E3C5D6: retire unreachable unsafe prototype surfaces

**Target files for complete-file rewrites** (after reading exact current content): `server.ts`, `src/App.tsx`, `src/components/SshTerminalDrawer.tsx` (delete only if confirmed unused) and related prototype/mock data utilities. Don't erase valid verified WorkOS routes or Linux agent modules.

**Required acceptance:**

1. Browser-supplied arbitrary OS/SSH commands are absent from backend and frontend, not merely disabled by the `403` gate.
2. No `Math.random`/hardcoded host measurements are presented as authentic; the dashboard shows a truthful `not connected`/`unavailable` state.
3. **Keep** every WebSocket upgrade denied until a separately reviewed authenticated, tenant-authorized real-time transport exists.
4. Preserve current WorkOS-protected API routes and keep absent agent/data APIs fail-closed.
5. Negative HTTP/WebSocket tests, unit tests, tenant security tests and build must pass; review new diffs for any accidental exposure.

### P0 — Subsequent protocol and monitoring stages

6. **Secure agent enrollment:** one-time expiring enrollment, hashed secrets, bounded credentials, organization binding, revocation, no shell.
7. **Authenticated ingestion:** outbound TLS agent protocol, request schema/size/rate limits, ownership validation, durable DB records and idempotent retries.
8. **Tenant-authorized monitoring:** live API, WebSocket auth/subscriptions and historical UI backed by PostgreSQL; propagate offline/stale/invalid states without fabricated values.
9. **Customer identity end-to-end:** WorkOS session lifecycle and operational service configuration, organization permissions and event audit throughout.

### P1 — Staging and production operations

10. Restore from encrypted offsite backups, credential recovery, PITR/WAL, actual RPO/RTO measurements and retention/deletion procedures.
11. Real human release approvals, key custody, independent audit trail, constrained migration executor and rehearsed deployment/rollback procedures.
12. Production TLS/secrets/headers/rate limits, vulnerability scanning, health/alerting, incident and customer support, data privacy policy.
13. Subscription/plan model, authenticated and idempotent billing events and enforcement for any paid launch.

### P2 — After secure core monitoring

14. Diagnostics, intelligent explanations, advanced notifications, additional OS agents and integrations, subject to their own scoped security reviews.

## Documentation drift remediation

The project handover (`docs/project/CURRENT-STATUS.md`), release checklist and security checklist still contain 2026-11-07 descriptions that do not reflect all subsequent authentication and migration milestones. Treat them as **historical evidence**, not current implementation proof. After code and test review, revise each file **end-to-end**, aligning checked boxes to demonstrated commands. Keep both explicit pending work and the `NO-GO` release decision.

## Reproducible, zero-database audit

The accompanying `scripts/audit/production-readiness.mjs` reads only an explicit allowlist of committed source/docs and `git rev-parse`. It refuses an unknown commit/branch, never reads `.env` or DB credentials, makes no connections, and prints only matched signal IDs and code locations. A missing signal is **NOT_OBSERVED_REVIEW_REQUIRED**, never an automatic safety pass. It always reports `NO_GO`, even if all searched strings disappear. The exit code 0 indicates only that inventory completed, **not** permission to deploy.

```bash
node --test scripts/audit/production-readiness.test.mjs
node scripts/audit/production-readiness.mjs
node scripts/audit/production-readiness.mjs --json  # optional; static facts only
```

**Phase exit criteria:** audit report reviewed, no secret-bearing files staged, objective blockers accepted as the next implementation queue, local read-only inventory green, roadmap owner records explicit launch NO-GO. No production resources or development database objects are modified by this phase.

**Source provenance:** Reviewed GitHub tree at exact commit above; original `docs/project/MASTER-ROADMAP.md`, `docs/project/RELEASE-CHECKLIST.md`, `docs/project/SECURITY-CHECKLIST.md`, project vision/ADR docs; and user-provided Nov 12 terminal transcript showing the named tests passing. Line anchors refer to this reviewed commit only. Any subsequent code change requires a fresh audit and independent verification.

**Pulse Metrics — Built to Last.**
