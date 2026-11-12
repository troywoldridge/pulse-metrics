#!/usr/bin/env node
/**
 * Pulse Metrics Phase 2E3C5D6 — read-only active-path retirement inventory.
 * Source-pattern assertions are regression guards, not a production audit.
 * This program never loads .env, connects to PostgreSQL or modifies files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED = Object.freeze([
  'server.ts',
  'src/App.tsx',
  'src/main.tsx',
  'src/components/AuthenticatedBoundary.tsx',
  'src/server/legacy-transport.ts',
  'src/agent/run-linux-agent.ts',
  'src/agent/linux-collector.ts',
]);
export const RETIRED = Object.freeze([
  'src/server/historical-store.ts',
  'src/components/SshTerminalDrawer.tsx',
  'src/components/AddHostModal.tsx',
]);
export const PROTECTED_BLOBS = Object.freeze({
  'src/main.tsx': 'ef12bb11e4796b05c4e57a07af0c1cfeddffedba',
  'src/components/AuthenticatedBoundary.tsx': 'dccc1e239988c3eb2950cbcf833b5d3b8f20395b',
  'src/agent/run-linux-agent.ts': '6864599b0404aa0f1219344c862c40ec415e92a9',
  'src/agent/linux-collector.ts': '235eb5fbabfeee5db294b6c0822c71ef1b0b24c1',
});

function check(id, pass, finding) { return { id, pass: pass === true, finding }; }

export function audit(sources, retired = {}) {
  for (const file of REQUIRED) {
    if (typeof sources?.[file] !== 'string') {
      throw Error(`REFUSE_RETIREMENT_AUDIT: missing reviewed file ${file}`);
    }
  }
  for (const file of RETIRED) {
    if (typeof retired[file] !== 'boolean') {
      throw Error(`REFUSE_RETIREMENT_AUDIT: missing file-existence proof ${file}`);
    }
  }
  const server = sources['server.ts'];
  const app = sources['src/App.tsx'];
  const transport = sources['src/server/legacy-transport.ts'];
  const entry = sources['src/main.tsx'];
  const auth = sources['src/components/AuthenticatedBoundary.tsx'];
  const agent = sources['src/agent/run-linux-agent.ts'];
  const collector = sources['src/agent/linux-collector.ts'];
  const checks = [
    check('no-server-shell-or-ssh', !/\b(?:exec|execSync|execFile|spawn|spawnSync|execAsync)\s*\(|from\s*['"](?:node:)?child_process['"]|\b(?:ssh|ssh2|exec_ssh)\b/.test(server),
      'No command execution or SSH transport remains in active server entry'),
    check('no-generated-server-metrics', !/Math\.random|\bwork-server\b|\blinux-pc\b|hostsData|seedHistoricalData|appendLivePoint|queryHistoricalData|startCollector|WebSocketServer/.test(server),
      'No simulated host, history or collector source in server entry'),
    check('workos-auth-mounted', /app\.use\(['"]\/api['"],\s*requireWorkOSUser\(createWorkOSVerifier\(readWorkOSAuthConfig\(\)\)\)\)/.test(server),
      'Authenticated API guard remains mounted'),
    check('organization-routes-preserved', [
      'createIdentityRoute()', 'createListOrganizationsRoute()',
      'createCreateOrganizationRoute()', 'createMembershipRosterRoute()',
      'createInvitationIssuanceRoute()', 'invitationRateLimits.network',
      'invitationRateLimits.actor',
    ].every(token => server.includes(token)), 'Organization, identity and invitation routes remain mounted'),
    check('deny-unimplemented-api', /app\.use\(['"]\/api['"],\s*denyPendingMonitoringApi\)/.test(server) &&
      /res\.status\(503\)\.json\(\{\s*error:\s*['"]organization_authorization_pending['"]\s*\}\)/.test(transport),
      'Unknown protected API requests fail closed without fake data'),
    check('deny-websocket-upgrade', /server\.on\(['"]upgrade['"],\s*rejectUnauthenticatedUpgrade\)/.test(server) &&
      /403 Forbidden/.test(transport) && !/101 Switching Protocols/.test(transport),
      'All WebSocket upgrades are denied until future authorization work'),
    check('local-only-bind', /server\.listen\(port,\s*['"]127\.0\.0\.1['"]/.test(server),
      'Current prelaunch server binds only to loopback'),
    check('browser-auth-boundary', /AuthKitProvider/.test(entry) && /AuthenticatedBoundary/.test(entry) &&
      /getAccessToken/.test(auth) && /\/api\/organizations/.test(auth),
      'Actual browser entry uses existing WorkOS organization holding screen'),
    check('no-browser-ssh-or-mock-ws', !/SshTerminalDrawer|AddHostModal|new WebSocket|exec_ssh|sshCommand|work-server|linux-pc|Math\.random/i.test(app),
      'Dormant dashboard scaffold contains no SSH, fake hosts or unverified stream'),
    check('honest-unavailable-state', /Measurements are unavailable/.test(app) &&
      /Monitoring not enabled/.test(app),
      'Dashboard scaffold shows unavailable measurements instead of invented values'),
    check('agent-not-repurposed', /local_terminal_only/.test(agent) &&
      /LinuxTelemetryCollector/.test(agent) && !/Math\.random/.test(collector),
      'Real Linux collector remains separate and transmission is still pending'),
    check('old-history-source-deleted', retired['src/server/historical-store.ts'] === false,
      'Fabricated history generator is removed from repository'),
    check('old-ssh-drawers-deleted', retired['src/components/SshTerminalDrawer.tsx'] === false &&
      retired['src/components/AddHostModal.tsx'] === false,
      'Obsolete interactive SSH terminal and SSH host setup components removed'),
  ];
  return {
    phase: '2E3C5D6',
    publicLaunch: 'NO_GO',
    note: 'Source guards alone cannot certify security. Agent enrollment, ingestion, monitoring APIs and production checks remain pending.',
    checks,
    passed: checks.filter(row => row.pass).length,
    total: checks.length,
  };
}

function gitBlob(root, file) {
  return execFileSync('git', ['hash-object', file], { cwd: root, encoding: 'utf8' }).trim();
}

export function auditCheckout(root) {
  const sources = Object.fromEntries(REQUIRED.map(file => [file, readFileSync(resolve(root, file), 'utf8')]));
  const retired = Object.fromEntries(RETIRED.map(file => [file, existsSync(resolve(root, file))]));
  const result = audit(sources, retired);
  const protectedState = Object.entries(PROTECTED_BLOBS).map(([file, expected]) => ({
    file, unchanged: gitBlob(root, file) === expected,
  }));
  return { ...result, protectedState, passedAll: result.passed === result.total && protectedState.every(v => v.unchanged) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.length !== 2) throw Error('No arguments accepted');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const result = auditCheckout(root);
    console.log('========== PHASE 2E3C5D6 READ-ONLY RETIREMENT AUDIT ==========');
    for (const row of result.checks) console.log(`${row.pass ? 'PASS' : 'FAIL'}: ${row.id} — ${row.finding}`);
    for (const row of result.protectedState) console.log(`${row.unchanged ? 'PASS' : 'FAIL'}: protected baseline unchanged — ${row.file}`);
    console.log(`Source regression checks: ${result.passed}/${result.total}`);
    console.log(`PUBLIC LAUNCH: ${result.publicLaunch}`);
    console.log(result.note);
    if (!result.passedAll) process.exitCode = 1;
  } catch (error) {
    console.error('REFUSE_RETIREMENT_AUDIT:', error instanceof Error ? error.message : 'invalid environment');
    process.exitCode = 1;
  }
}
