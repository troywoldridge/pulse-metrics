# Pulse Metrics — D11–D14 Agent Enrollment Development Block Closeout

**Review status:** D14 candidate pending host-level verification and Git commit.
**Production status:** **NO-GO — public enrollment is not active.**

## Purpose

This document closes the *offline engineering foundation* after D14 host
verification, without asserting a production deployment or customer readiness.
The complete path has four sequential independently tested components:

| Stage | Engineering boundary | Evidence and scope |
| --- | --- | --- |
| D11 | Linux machine credential custody | `0700` directory, `0600` file, symlink/hard-link denial, safe initial install and explicit compare-and-swap rotation; local filesystem tests |
| D12 | HTTPS redemption client | TLS chain and hostname verification, canonical origin, no redirects or retries, strict response contract and vault handoff; temporary loopback TLS tests |
| D13 | Server-approved machine identity | New versioned migration `0003` preallocates tenant/agent ID, single-use token binding, denied cross-tenant operations and concurrent redemption; real **disposable** PostgreSQL rehearsal |
| D14 | Operator-controlled token input | Hidden/no-echo TTY and protected descriptor input, exact prior expected IDs, opt-in HTTPS+vault composition and no secret in argv/env; synthetic local tests |

## D14 acceptance gates

- Historical D11–D13 Git blobs have not changed, including the verified D13
  SQL candidate (SHA-256:
  `c085dd674581abe6a636de8cd586e43de745d35ee965c0e141f8dc4015d3b406`).
- No public enrollment route is mounted and `run-linux-agent.ts` stays local
  telemetry only. `npm test` recursively discovers **all** TypeScript tests.
- D14 token-reader, CLI, end-to-end temporary TLS and negative tests pass.
- D14 source-regression tests pass, TypeScript checks, build and Drizzle
  schema checks pass, and `git diff --cached --check` passes **after**
  staging the twelve D14 files (unstaged/untracked files are not covered by
  `git diff --check`).
- Original D13 **real PostgreSQL** rehearsal has passed against a fresh
  disposable Unix-socket cluster and left the existing database unchanged.
- Reviewed D14 files are committed and pushed on
  `feat/identity-organization-onboarding` with a clean tree.

**After all of these are verified, mark only the D11–D14 development block
complete.** Do not mark public launch, agent onboarding or real telemetry
transport complete.

## Outstanding production release gates — mandatory

1. Signed-off versioned migration adoption, backup, staging rollback,
   reconciliation of issued legacy tokens and cleanup of pending agents.
2. Real edge TLS, correct origin and certificate lifecycle, proxy trust,
   WorkOS authentication, organization owner/admin authorization and persisted
   actor/network rate limits across replicas.
3. Approved operator-facing issuance display, protected token transport,
   preallocated IDs from authenticated issuance, issuance expiration and
   incident handling for consumed tokens or failed local filesystem writes.
4. Dedicated unprivileged Linux service, signed versioned installer/updates,
   permission review, credential lifecycle/rotation and revocation exercises.
5. Authenticated **real measured** telemetry submission, bounded ingest,
   tenant-safe persistent storage, offline/backpressure policy, retention and
   authorized dashboard/history reads.
6. Independent staging integration and security review before production
   activation, customer data or marketing claims of operational monitoring.

## Next development direction

Once D14 is committed, stop adding enrollment scaffolding and turn to the
reviewed deployment/telemetry plan: stage verified TLS and database migrations,
exercise one authentic end-to-end agent enrollment with an authorized operator,
then design the authenticated telemetry ingestion pipeline. The product is a
commercial, multi-tenant monitoring SaaS. **No SSH-based monitoring, fake
measurements, unbounded remote command execution or hidden unsafe shortcuts.**
