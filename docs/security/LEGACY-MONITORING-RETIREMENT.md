# Pulse Metrics — Phase 2E3C5D6: Legacy monitoring backend retirement

**Status:** Local source remediation package; host tests pending. **Public launch: NO-GO.**

**Reviewed starting branch:** `feat/identity-organization-onboarding`

**Reviewed starting commit:** `2e064f8bd818cd2e40c27c1bb2255853b685e18a` (`docs(security): audit production readiness and launch blockers`)

## Purpose and scope

The earlier 2E3C5D5 source inventory identified legacy arbitrary SSH command execution, random/fabricated metrics, hardcoded prototype hosts, synthetic history, and a browser interface that attempted untrusted WebSocket commands. The active customer entry point (`src/main.tsx`) already mounts `AuthenticatedBoundary` rather than the obsolete `src/App.tsx`; the server already rejects all WebSocket upgrades. This increment **removes** obsolete code instead of trusting it to remain unreachable.

No attempt is made to turn on a live dashboard, enable customer monitoring, enroll agents or ingest data. This is a deliberate security **removal** milestone, not a claim that the commercial monitoring product is functional.

### Full-file replacements

- `server.ts`: A reduced Express server preserving its existing health, WorkOS authentication, organization list/create, membership roster, and invitation issuance middleware and handlers. It keeps the pre-auth invitation network rate limiter and authenticated actor limiter in their existing order. Any other `/api` request is authenticated, then refused with a `503 organization_authorization_pending` response. All WebSocket upgrades are rejected. No shell, SSH, WebSocket server, fabricated hosts, in-memory history or synthetic speed-test execution remains. The local prelaunch HTTP listener binds to `127.0.0.1` only.
- `src/App.tsx`: Entire unmounted prototype dashboard is replaced by an honest unavailable-state scaffold. It makes no live requests, generates no metrics and offers no SSH controls. The *actual* WorkOS-enabled customer entry remains `src/main.tsx` + `AuthenticatedBoundary`, which this package does not change.

### Added supporting code

- `src/server/legacy-transport.ts`: Small, explicit fail-closed HTTP and WebSocket upgrade handlers; no telemetry or command-execution capability.
- `src/server/legacy-transport.test.ts`: Real local HTTP requests prove generic monitoring APIs return `503` with `Cache-Control: no-store`; a raw WebSocket upgrade handshake must receive HTTP `403`.
- `scripts/retirement/source-audit.mjs`: Read-only 13-check source inventory. Checks WorkOS API/auth route mount presence, explicit unavailable paths, local-only listener, no server shell or simulated metrics, and the deletion of the obsolete modules. It also checks the exact unmodified Git blob IDs of the browser authentication entry, authentication holding screen and measured Linux collector modules.
- `scripts/retirement/source-audit.test.mjs`: 16 regression cases covering acceptance and deliberate negative mutations.

### Files removed

- `src/server/historical-store.ts` — fabricated in-memory historical measurement generator.
- `src/components/SshTerminalDrawer.tsx` — browser arbitrary-command interface.
- `src/components/AddHostModal.tsx` — SSH-based host enrollment form.

These exact three paths are the only deletions permitted by the installer. Their existing Git blobs are checked before removal. Git history continues to retain earlier versions for design reference.

## Preserved safety boundaries

1. The existing database, Drizzle schema, migrations, RLS, privileged SQL steps, receipts, release approvals, recovery rehearsals, agent collector and WorkOS module files are **not rewritten**.
2. Human identity is verified before protected API operations. Unknown monitoring APIs remain unavailable even for authenticated users; unauthenticated requests are rejected by the existing WorkOS guard.
3. The WebSocket upgrade path remains `403`. Do not enable it until authenticated transport tickets, organization subscriptions, per-event authorization and cross-tenant denial tests are complete.
4. The genuine Linux collector is still a **local-terminal-only** utility. It does not transmit anything to this server. Do not present measurements as live customer telemetry or persist them under an unverified identity.
5. `server.ts` binds to `127.0.0.1`. Do not expose a public internet service until reviewed transport security, correct proxy boundaries, secure enrollment and the release checklist are met.

## Explicit remaining debt

- Unmounted dashboard widget components and `src/types/metrics.ts` still include legacy SSH/terminal-era presentation and type fields. They are not imported by the customer entry point; a future tenant-safe dashboard implementation should refactor/remove these at the same time as authenticated data access. Their presence does not authorize remote commands, but they must not be reconnected unreviewed.
- The `ssh2` and `@types/ssh2` packages remain in dependency manifests for now, despite no longer being imported by the active server. Remove these and regenerate/review `package-lock.json` in a separate focused dependency cleanup.
- `docs/project/CURRENT-STATUS.md` and some legacy checklists contain historical descriptions. Refresh them in a separately reviewed full-file documentation update, preserving accurate verified-versus-pending distinctions.
- The previous `scripts/audit/production-readiness.mjs` is a source audit of a **pinned earlier commit**, not a current readiness check. It deliberately refuses later commits and still expects a now-removed historical store file. Use the new retirement audit for this phase; keep the old one as historical evidence.
- Secure agent enrollment, credential rotation/revocation, authenticated telemetry ingestion, data retention, authorized current/history APIs, WebSockets, dashboard freshness, billing, encrypted offsite backup/PITR, operator identity and end-to-end production checks remain pending.

## Installation and testing

The package installer checks the exact Git commit and branch, clean worktree, original Git blob hashes, unchanged protected code and SHA-256 hashes for every replacement. It rewrites the **complete contents** of `server.ts` and `src/App.tsx` (not a partial patch), adds the new tests/docs, removes only three verified obsolete files, and attempts rollback if an installation operation fails. The installer does not access environment variables, launch services, connect to PostgreSQL, run migrations or commit changes.

From the project checkout after reviewing the package and installer:

```bash
node --test scripts/retirement/source-audit.test.mjs
node scripts/retirement/source-audit.mjs
npm test
npm run lint
npm run build
npm run db:check
node --test scripts/migrations/verify-manifest.test.mjs
python3 -B scripts/recovery/verify-restored-catalog.test.py
```

Additional local-only manual checks if the server is intentionally started with your existing development configuration:

```bash
curl -i http://127.0.0.1:3000/api/health
curl -i http://127.0.0.1:3000/api/history
```

Expected: health returns minimal `200`; unauthorized history receives `401` from the WorkOS middleware; even a valid authenticated user does not obtain monitoring history (`503` is returned after auth). No test in this package attempts to authenticate with real WorkOS credentials or collect real customer telemetry. Keep services local-only.

### Acceptance criteria

- All 13 source checks and all 16 static regression tests pass, plus both new live HTTP/WebSocket denial tests.
- Existing application tests, TypeScript, build, migration manifest and Drizzle checks pass.
- Only the expected project files are changed, no source/secret files are accidentally staged, no whitespace errors.
- A separately reviewed diff confirms all required WorkOS + organization APIs remain present and dangerous legacy handlers really are removed.
- **No public launch.** Completing this narrow code-removal phase leaves real agent transport and customer monitoring as the next primary milestone.

**Standard: no fake measurements, no arbitrary customer SSH, no silent privilege expansion. BUILT TO LAST.**
