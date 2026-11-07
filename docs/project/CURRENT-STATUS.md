# Pulse Metrics — Current Project Status

**Last updated:** 2026-11-07
**Active branch:** feat/commercial-database-foundation

This document is the project handover record. Update it whenever a meaningful
milestone is completed or the next development task changes. A checked item
must be supported by implementation or verification evidence described here.

## 1. Overall position

Pulse Metrics is transitioning from a monitoring prototype toward a
commercial, multi-tenant infrastructure monitoring and IT intelligence
service.

The PostgreSQL database foundation and repeatable tenant-isolation integration
tests have been implemented. Initial genuine Linux telemetry collection,
a versioned telemetry contract, a sampling engine and a standalone local
runner have also been implemented.

The local runner has been started successfully and observed emitting two
successive telemetry envelopes at the configured five-second interval.
The first CPU usage sample was correctly marked unavailable because a second
counter reading was required; the next sample contained a measured CPU usage
value. Other observed readings included CPU core count and load averages,
memory, swap, root filesystem capacity, cumulative network byte counters and
system uptime.

The local agent is a development-only collector. It currently writes
structured telemetry to the local terminal. It does not authenticate,
enroll with an organization, connect to the SaaS service, submit telemetry
over a network, or persist samples.

**Production readiness has not been achieved. Public customer onboarding is
not permitted.**

## 2. Verified progress

### Repository and development foundation

- [x] Canonical repository established:
  https://github.com/troywoldridge/pulse-metrics.git
- [x] Commercial database foundation feature branch created.
- [x] Project architecture and roadmap documentation exists.
- [x] Runtime and migration database connection settings are separated.
- [x] `.env` is ignored by Git.
- [x] Gemini integration is not required for the core monitoring product.
- [x] Existing work is being preserved on the feature branch; current Git
  state must be rechecked before staging or committing.

### Database infrastructure

- [x] Local PostgreSQL database `pulse_metrics` created.
- [x] Dedicated `pulse_metrics_app` runtime role created.
- [x] Dedicated `pulse_metrics_migrator` role created.
- [x] Both roles verified as non-superuser and without RLS bypass.
- [x] Runtime role cannot create schemas or database objects.
- [x] Migration connection tested.
- [x] Runtime connection tested.
- [x] Initial Drizzle migration applied successfully.
- [x] Eight application tables created.
- [x] Row-level security enabled and forced on all eight application tables.
- [x] Fourteen RLS policies created.
- [x] Application grants restricted to approved operations.
- [x] Application role denied access to enrollment tokens and agent credentials.
- [x] Application role denied telemetry and audit update/delete/truncate.
- [x] Actual runtime permission tests passed.
- [x] Drizzle schema check passed on 2026-11-07.

### Tenant isolation

- [x] Tenant-context helper validates UUID inputs.
- [x] Organization context is cleared before membership verification.
- [x] User identity is set transaction-locally.
- [x] Membership is checked before organization context is installed.
- [x] Organization context is set transaction-locally.
- [x] User A can read Organization A agent and telemetry data.
- [x] User B can read Organization B agent and telemetry data.
- [x] Cross-organization access is denied in the tested paths.
- [x] Unscoped agent and telemetry queries return no tenant rows.
- [x] Malformed organization UUIDs are rejected.
- [x] Malformed user UUIDs are rejected.
- [x] Nonexistent user access is denied.
- [x] Nonexistent organization access is denied.
- [x] Deleted/revoked membership is denied.
- [x] Transaction-local tenant context is cleared after completion.
- [x] Single-connection reuse does not retain the previous tenant context.
- [x] Repeatable integration fixture setup implemented.
- [x] Integration fixture cleanup implemented through an exit trap.
- [x] Integration command documented as `npm run test:integration`.
- [x] Integration command passed twice.
- [x] Separate cleanup query confirmed zero remaining test fixtures.

The repeatable integration test covers the specific tenant-context and
database-security scenarios listed above. It is not proof that every possible
tenant-isolation attack path has been covered, and it does not test
customer-facing API authorization because that layer is not complete.

### Local Linux telemetry foundation

- [x] Versioned telemetry contract implemented (`schemaVersion: 1`).
- [x] Metric names, units, timestamps and availability states are defined.
- [x] Telemetry sample and envelope validation implemented.
- [x] Linux collector reads CPU counters from `/proc/stat`.
- [x] CPU usage is calculated from successive counter readings; the initial
  sample is reported as unavailable rather than fabricated.
- [x] CPU core count and load averages are collected through Node's OS APIs.
- [x] Memory and swap values are read from `/proc/meminfo`.
- [x] Root filesystem capacity and available space are read using `statfs`.
- [x] Cumulative network byte counters are read from `/proc/net/dev`.
- [x] System uptime is collected through Node's OS APIs.
- [x] Unsupported or unavailable measurements use explicit availability
  states rather than invented numeric values.
- [x] Collector and sampler are separated from the Express dashboard server.
- [x] Sampling engine prevents overlapping collections and shares an active
  collection between concurrent callers.
- [x] Standalone `npm run agent:linux` command implemented.
- [x] Runner validates telemetry envelopes before reporting samples.
- [x] Runner emits structured local terminal output and error records.
- [x] Runner code contains no telemetry HTTP submission or database write.
- [x] Manual runner execution observed two successive valid envelopes at a
  five-second interval on 2026-11-07.

Important measurement limitations:

- Network values currently represent cumulative byte counters, not bytes per
  second or network speed.
- The current collector aggregates non-loopback interfaces. Virtual,
  bridge and physical interface relationships can cause double counting.
  These aggregate values must not yet be treated as commercially accurate
  per-device network traffic or rates.
- CPU load averages are load averages, not CPU utilization percentages.
- Process-level telemetry, CPU temperature, disk I/O and per-interface
  network identity are not currently part of this initial collector.
- The runner is Linux-only and local-only.

### Automated verification

Verified on 2026-11-07 after the standalone Linux runner additions:

| Check | Result |
|---|---|
| `npm run lint` | Passed |
| `npm test` | 57 passed, 0 failed |
| `npm run test:integration` | Both initial-membership and revoked-membership phases passed |
| Integration fixture cleanup | Temporary organizations, users, memberships, agents and telemetry removed |
| `npm run db:check` | Passed |
| `npm run build` | Passed |

The production build completed successfully. Vite reported non-blocking warnings
about `__dirname` in the native config loader and a JavaScript chunk exceeding
500 kB after minification. These are follow-up improvements, not build failures.

The standalone runner was manually started with `npm run agent:linux`.
Two successive telemetry envelopes were observed at the configured
five-second interval. The first CPU usage sample was correctly unavailable
until a second counter reading was available. Pressing Ctrl+C successfully
stopped the runner, verifying manual SIGINT shutdown. Manual SIGTERM shutdown
has not yet been independently verified.

These checks verify the current local development foundation. They do not
establish production readiness or complete customer-facing application
security.

## 3. Current worktree and Git state

The worktree contains uncommitted database, documentation, script, test,
package and agent work. The exact current state must be checked before
staging or committing:

```bash
git status --short
git diff --check
```

Previously observed uncommitted paths included `.env.example`,
`package.json`, `package-lock.json`, `docs/project/`, `drizzle/`,
`scripts/`, `src/agent/` and `tests/`. This list may be stale and must not
be used as a substitute for a fresh `git status`.

Preserve all existing work. Do not discard, reset or overwrite unrelated
changes. No commit or push for this checkpoint is recorded yet.

## 4. Completed milestones

### Milestone A — Repeatable PostgreSQL tenant-isolation integration tests

The milestone's defined requirements have been met:

- [x] Tests create their own temporary fixtures.
- [x] Application-path operations use the restricted runtime database role.
- [x] Cross-tenant access is denied in the tested scenarios.
- [x] Missing and revoked membership is denied.
- [x] Invalid UUID inputs are rejected.
- [x] Transaction-local tenant context is cleared.
- [x] A single pooled connection can be reused without tenant-context leakage.
- [x] Cleanup is attempted after test execution, including failure paths.
- [x] The documented command runs successfully.
- [x] The integration command has passed twice.
- [x] Cleanup verification reports zero remaining fixtures.

This completes the current database tenant-isolation test objective. It does
not complete the application's overall security or production readiness
requirements.

### Milestone B — Initial local Linux telemetry runner

**Status: Implemented; automated verification and manual SIGINT shutdown passed.**

- [x] Initial Linux telemetry collector implemented.
- [x] Versioned telemetry contract and validation implemented.
- [x] Sampling engine implemented with overlap prevention.
- [x] Standalone local runner implemented.
- [x] Manual execution produced successive real telemetry envelopes.
- [x] Latest `npm run lint` and `npm test` pass after runner additions.
- [x] Manual SIGINT shutdown verified by pressing Ctrl+C.
- [ ] Manual SIGTERM shutdown independently verified.
- [x] Production build passes with the latest changes.

This milestone is intentionally local-only. It does not complete secure
customer agent enrollment, authenticated ingestion or telemetry persistence.

## 5. Known limitations and future work

Still required:

- User authentication and secure sessions.
- Trusted server-side user identity.
- Organization provisioning and membership administration.
- Organization role and permission enforcement.
- Agent enrollment and credential verification.
- Agent credential rotation and revocation.
- Authenticated telemetry ingestion and persistence.
- API authorization and rate limiting.
- Audit-event generation and review.
- Customer dashboard authorization and replacement of prototype data paths.
- Removal or safe replacement of prototype SSH and arbitrary remote command
  execution.
- Network interface identity and accurate network-rate calculation.
- Additional safe metrics and operating-system support.
- Subscription and billing enforcement.
- Operational monitoring, backup and recovery.
- Data retention and deletion policies.
- Security, performance and production acceptance testing.

Do not expose the existing prototype's arbitrary SSH/WebSocket command
execution as an unauthenticated customer capability. Any future remote
administration functionality requires a separately reviewed security design.

## 6. Next development milestone

**Immediate task: complete the reviewed Git checkpoint.**

The latest lint, unit tests, PostgreSQL integration tests, Drizzle check,
production build and manual SIGINT shutdown verification passed on
2026-11-07. Review the staged changes, preserve all existing work, then
commit and push the feature branch.

Manual SIGTERM shutdown verification remains outstanding and should be
completed as a follow-up validation item.

**Next architectural milestone: authentication, trusted identity and
organization access.**

Recommended sequence:

1. Define the authentication provider and secure session model.
2. Implement server-side authentication verification.
3. Establish trusted user identity from verified authentication claims.
4. Implement organization provisioning.
5. Implement organization membership administration.
6. Enforce organization roles and permissions in server-side operations.
7. Add automated tests for authenticated and unauthorized API access.
8. Review session security, account lifecycle and recovery behavior.

After the identity foundation is verified, proceed to secure agent enrollment:

- One-time enrollment tokens.
- Hashed token storage.
- Token expiry and single-use enforcement.
- Authenticated agent credential issuance.
- Credential rotation and revocation.
- Authenticated telemetry ingestion.

Do not move customer onboarding into production until authentication,
authorization, enrollment, telemetry ingestion and operational security
requirements have been implemented and reviewed.

## 7. Project health statement

**Current stage:** PostgreSQL tenant-isolation foundation completed; initial
local Linux telemetry collector and runner implemented and verified locally.

**Production readiness:** Not achieved.

**Public customer onboarding:** Not permitted yet.

**Next priority:** Finish local runner verification and establish a clean Git
checkpoint, then implement authentication, trusted server-side identity and
organization access controls before secure agent enrollment.
