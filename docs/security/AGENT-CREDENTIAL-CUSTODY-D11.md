# Pulse Metrics — Phase 2E3C5D11 Agent Machine Credential Custody

**Status:** Offline code and local filesystem rehearsal only. **PUBLIC LAUNCH: NO-GO.**

## Trust boundary

The D8 redemption response contains exactly `organizationId`, `agentId`, and
`machineCredential`. Phase D11 strictly validates this response and offers an
**unmounted, Linux-only** local credential store. It does **not** contact the
server, perform enrollment, enable telemetry transport or wire the agent runner.
It cannot independently prove TLS origin, WorkOS authorization, the identity of
the issuing API or the server's actual revocation state.

A future approved deployment must: validate the SaaS HTTPS hostname against a
trustworthy CA, verify the expected organization and agent identity out of
band, protect the raw redemption response in memory, call the storage primitive
exactly once, and never print the secret. Installation must not pass secrets in
command-line arguments, URLs, environment variables or shell history.

## Local filesystem invariants

- Linux only, under the UID of a dedicated **unprivileged** agent account.
- Caller specifies an **absolute, canonical** credential directory. No default
  path is inferred from a developer's home or machine.
- Ancestors cannot be symlinks or insecure group/world-writable directories,
  except root-owned sticky directories such as `/tmp` for test fixtures.
- The leaf directory must be **0700 and owned by the running UID**.
- The credential file `machine-identity.json` must be a non-symlink regular
  file, **0600**, owned by the UID, with one hard link, and at most 512 bytes.
- Installation refuses to overwrite a credential. Rotation requires the exact
  previous secret and **unchanged organization and agent IDs**.
- Writers use an exclusive owner-only lock, an exclusive 0600 temporary file,
  `fsync`, atomic rename, and directory sync. Failed operations deny access.
- A crash may leave a `.machine-identity.lock` file. **Do not automatically
  delete or retry** without checking whether the server credential rotated.
- Errors are intentionally generic and never include credential contents.
- These controls do not substitute for encrypted host storage, a secure OS
  account, trustworthy system packages or reliable filesystem ownership.

## What is not provided

No CLI or REST endpoint imports a credential. No automatic local rotation,
registration, secret distribution, container secret mount, systemd unit or
telemetry ingestion is enabled. D11 does **not** claim protection from a
compromised agent process or a root attacker. The agent currently collects
real metrics locally and is not authorized to send them over the network.

## Tests

Run `npm test` after the D10 test-discovery fix has been committed. Test files:
`src/agent/security/machine-identity.test.ts` and
`src/agent/security/credential-vault.test.ts`.

Then run `npm run lint`, `npm run build`, `npm run db:check`,
`node --test scripts/agent-custody/verify-foundation.test.mjs`,
`node scripts/agent-custody/verify-foundation.mjs`, and `git diff --check`.
All tests use synthetic secrets in throwaway local directories. No database,
WorkOS credential or internet access is necessary for the D11 code.

## Future deployment approval prerequisites

1. D10 and the test-discovery fix reviewed, committed and pushed.
2. Production-approved SQL migration and recovery/rollback procedure.
3. Real TLS origin and reverse-proxy trust tests.
4. Real WorkOS bearer validation and independent per-organization role checks.
5. Enrollment rate-limit keys and operational monitoring under shared custody.
6. A **client-side enrollment flow** that validates HTTPS, server response,
   expected agent identity and secure one-time storage without leaking secrets.
7. Agent token rotation, renewal, revocation and safe operator recovery.
8. Signed agent update supply chain, operating-system service isolation,
   credential backup rules and incident response.

The active `server.ts` enrollment routes remain unmounted until these gates
have independently reviewed evidence. Do not change that in this phase.
