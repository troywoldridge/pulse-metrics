# Pulse Metrics — Phase 2E3C5D12 Secure Agent HTTPS Enrollment Client

**Status:** Unmounted HTTPS transport and optional local credential installation only.

**Public launch:** **NO-GO**. No production routes, migration, token distribution, telemetry ingestion or agent service wiring is enabled by this phase.

## What this phase adds

- `src/agent/enrollment/https-redemption.ts` makes a **real** Node HTTPS request to a **fixed endpoint**, `POST /api/agent-enrollments/redeem`. It accepts only a canonical HTTPS **origin** and rejects embedded credentials, URLs containing paths, queries and fragments, HTTP downgrades and noncanonical origins.
- Node HTTPS certificate-chain and hostname verification are required (`rejectUnauthorized: true`); TLS 1.2 is the minimum. The optional CA PEM is an **operator-reviewed** trust anchor for private PKI/staging, **not** a TLS verification bypass. Normal public CA trust is used when omitted. Node HTTPS does not automatically follow redirects; all non-201 responses are refused.
- The request sends only `{token,agent}` as JSON, with a strict Linux agent description. The token is never sent in a URL, query string, header, CLI argument or environment variable by this primitive. No automatic retries: the token may have been consumed even when a reply was lost.
- A successful response must be JSON, `Cache-Control: no-store`, 201, uncompressed, at most 1024 bytes, and have the **exact three-field** credential shape from D11. It must match the independently expected organization ID, and any independently expected agent ID. Errors are generic and never echo TLS errors, URLs, secrets or server response bodies.
- `src/agent/enrollment/enrollment-workflow.ts` optionally composes the HTTPS redemption with D11's owner-only credential vault. **It refuses to store anything unless a trusted caller supplies an agent ID independently of the redemption response.** It preflights obvious existing credential files, then delegates final owner/permission/lock checks to D11. Its response contains only non-secret IDs.
- The client **never** imports or starts the main telemetry collector. The current Linux runner still outputs genuine metrics only to its local terminal and does not transmit data.

## Identity trust issue to resolve before rollout

The current server creates the new agent ID **during** redemption. That response is not independent proof that the new ID belongs to the authorized enrollment. D12 consequently has two deliberate modes:

1. `redeemEnrollmentOverVerifiedHttps(...)` returns an in-memory `MachineIdentity` **without writing it to disk**. An operator-controlled workflow must independently confirm the agent ID before any persistence.
2. `redeemAndInstallVerifiedMachineIdentity(...)` requires `expectedAgentId` to be established **before** the HTTPS call by a separate trusted control-plane action, not copied out of the reply. This is tested but cannot yet be used to enroll a newly allocated agent ID with the current server API.

The production control plane should pre-allocate/bind a pending agent identity to an enrollment token, or provide another authenticated out-of-band verification channel, before automatic installation is enabled. **Do not weaken D11's independent identity check to make a test pass.**

## Credential delivery and recovery boundaries

- The caller provides the one-time secret in process memory; **there is no CLI** and no shell command accepting the token. A later operator CLI must use an appropriately protected standard input/FD workflow, never argv, shell history, logs, environment variables or a URL.
- Transient network failure has **no automatic retry**; redemption might have succeeded while the response was lost. Reconcile with the control plane and revoke/reissue instead of blindly retrying.
- Local vault failure after the server consumes a token needs **manual reconciliation** and possible revocation. D12 cannot make the remote redemption and local `fsync` atomic across a network.
- D11's 0700 directory, 0600 credential, exclusive lock and symlink/hard-link protections remain unchanged. The vault is not encrypted against a compromised UID or root.
- This transport's optional private CA trust is an operator configuration; a malicious trust anchor defeats service authentication. Staging certificates and their generated private keys exist **only in tests' throwaway directories** and are never included in the ZIP.
- This phase does not yet implement certificate/public-key pin rollover, a secure enrollment token handoff UX, signed distribution artifacts, or production ingress/TLS and reverse-proxy deployment attestation.

## How to test

`npm test` must discover **31 test files** and include all D12 HTTPS and credential-workflow tests. The tests generate ephemeral self-signed certificates with `openssl`, start loopback-only HTTPS servers, exercise chain and hostname verification, redirect denial, response-size limits, malformed responses, timeouts, and one-time local vault installation with synthetic secrets. These are not public network calls.

Run `node --test scripts/agent-https/verify-foundation.test.mjs`, `node scripts/agent-https/verify-foundation.mjs`, `node scripts/agent-https/launch-gate.mjs`, `npm test`, `npm run lint`, `npm run build`, `npm run db:check`, `git diff --check` and the historical migration verifiers. Do **not** run live enrollment commands or modify your development database for D12.

## Next work

1. Review approved staging-only HTTPS origin and deployment trust configuration.
2. Define a **pre-authorized agent identity** workflow and authenticated operator confirmation.
3. Create a secure **stdin/FD-based** enrollment CLI with no terminal echo or secret logging and explicit anti-replay behavior.
4. Verify real WorkOS owner/admin issuance, deployment migration approvals, proxy/TLS and distributed quotas in staging.
5. Implement authenticated genuine telemetry ingestion, tenant-safe history, backpressure, offline buffering policy and audited data retention.

**No customer access and no public server route activation in D12.**
