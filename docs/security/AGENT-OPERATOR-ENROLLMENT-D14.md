# Pulse Metrics — Phase 2E3C5D14 Secure Operator Agent Enrollment

**Status:** Review-only, opt-in Linux command-line workflow. **PUBLIC LAUNCH: NO-GO.**

## Purpose

D14 composes the existing, reviewed foundations without editing or activating
D9–D13: D11 0700/0600 credential custody; D12 verified HTTPS and no retries;
D13 **independently preallocated** tenant-bound machine identity. The D14
command-line tool only runs when an operator explicitly invokes it. The
current `server.ts` enrollment routes remain **unmounted**, the Linux telemetry
runner remains **local-only**, and the working database remains unchanged.

D14 does not create or retrieve a WorkOS authorization, issue enrollment tokens,
run the customer control-plane UI, apply migration 0003 to a live database, or
start an agent service. It must not be treated as an active enrollment feature.

## Trust and operator sequence (once infrastructure is separately approved)

1. Sign in to the **verified** Pulse Metrics control plane and request an agent
   from an authorized owner/admin organization membership. Its D13 issuance
   must preauthorize an exact Linux machine description and return the
   **organization ID and agent ID before redemption**. Independently compare
   those two IDs with the approved target. Do not learn `expectedAgentId` from
   the unauthenticated redemption response.
2. Obtain the one-use token through a protected issuance display/session. It
   expires after the server's configured interval (D13: 10 minutes). Do not
   include it in commands, flags, URLs, environment variables, shell history,
   tickets, chat messages, logs or screenshots. A token pasted into an
   untrusted terminal or a recorded session can still be stolen.
3. Verify the HTTPS origin's spelling and certificate/hostname. For a private
   staging PKI, select a separately vetted CA certificate using
   `--trusted-ca-file`; never disable verification or accept an arbitrary CA.
4. Run the **opt-in** D14 CLI as a dedicated unprivileged Linux account, using
   an absolute protected credential directory. Provide nonsecret parameters
   with the flags below and provide the token in the **hidden TTY prompt**.
   Headless automation may supply a protected FD 3 or redirected stdin from a
   reviewed secret broker, **never** an inline shell `echo` or `printf` token.
5. The D12 client issues **one** HTTPS POST on a fixed path. It rejects TLS
   mismatch, redirects, non-201 status, invalid content-type, compression,
   malformed or oversized response and mismatched tenant/agent IDs.
6. D11 creates or verifies the 0700 directory and 0600 credential using an
   exclusive lock and atomic write. Successful CLI output contains **only**
   `status`, `organizationId`, and `agentId`, never the secret.
7. A failure *after* remote redemption can consume the token without storing
   the credential. **Do not blindly retry.** Inspect authenticated server
   status, revoke/reconcile the pending/active agent and issue a fresh
   authorization under a reviewed operator recovery runbook.

## Supported CLI arguments

All arguments are **nonsecret** except that the enrollment token is requested
later through a separate input channel. Supply these flags as pairs:

- `--origin`: the canonical `https://hostname[:port]` origin, no trailing slash,
  path, query, embedded credentials or fragment.
- `--organization-id`: independently authorized tenant UUID from issuance.
- `--agent-id`: preallocated UUID from issuance, **not** redemption.
- `--credential-dir`: canonical absolute path for the unprivileged agent UID.
- `--display-name`, `--hostname`, `--architecture`: exact D13-authorized Linux
  description (`x86_64` or `aarch64`).
- Optional `--trusted-ca-file`: reviewed PEM CA certificate path, not a private
  key; the file must be a regular file and not a symlink.
- Optional `--token-source tty|stdin|fd3` (default `tty`). `tty` hides input,
  disables local echo and restores terminal mode; `stdin` must be redirected
  from a trusted provider; `fd3` reads an explicitly opened descriptor. A
  regular input file must be owned by the current UID and have exactly `0600`
  permissions and one link. Pipe/socket input is accepted. Inputs must contain
  exactly one canonical 43-character token with optional one newline/CRLF.

Example shape — **DO NOT RUN** until a real authorized control plane, approved
TLS origin and server enrollment endpoints exist:

```bash
node --import tsx src/agent/enrollment/operator-cli.ts \
  --origin https://approved-monitoring.example \
  --organization-id "<independently-authorized-organization-uuid>" \
  --agent-id "<preallocated-agent-uuid>" \
  --credential-dir /var/lib/pulse-agent/identity \
  --display-name 'Approved Linux Machine' \
  --hostname approved-linux.example \
  --architecture x86_64 \
  --token-source tty
```

This CLI is a **development source tool** using the repository's `tsx`
dependency, not a signed or installed customer binary. It never auto-starts
under `server.ts` or `npm run agent:linux`. Test certificates are generated
only in temporary test directories. No real customer token should be used
while the API remains unmounted.

## Boundaries and residual risks

- JavaScript strings containing the secret cannot be guaranteed to be erased
  from memory. A compromised host UID, `root`, keylogger, shell session
  recorder, untrusted clipboard, process debugger or terminal can still reveal
  a token or credential. `0600` is not encryption.
- TTY raw-mode no-echo and explicit FD validation reduce accidental leakage,
  but cannot make an untrusted operator workstation trustworthy.
- A local filesystem failure after successful redemption is not atomic with
  remote database state. Manual reconciliation is required.
- A previously activated credential is **not** a sign that telemetry is being
  delivered. D14 does not create a systemd unit, automatic rotation, device
  inventory sync, telemetry transport or customer dashboard read permission.
- A production release still needs an independently approved migration,
  actual TLS proxy and WorkOS authorization, authenticated token handoff,
  operator confirmation UX, incident runbooks, signed distribution and
  security review. The active deployment gate stays **NO-GO**.

## Verification

Use `node --test scripts/agent-operator/verify-foundation.test.mjs`,
`node scripts/agent-operator/verify-foundation.mjs`,
`node scripts/agent-operator/launch-gate.mjs`, `npm test`, `npm run lint`,
`npm run build`, `npm run db:check`, `git diff --check` and historical migration
regression checks. The new tests exercise hidden terminal input, 0600 FD input,
HTTPS validation, identity mismatches, non-retry and sanitization with synthetic
secrets and loopback TLS only. No production SQL is run. The existing D13
isolated PostgreSQL rehearsal remains separate and unchanged.
