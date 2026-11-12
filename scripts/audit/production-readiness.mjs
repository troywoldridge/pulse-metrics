#!/usr/bin/env node
/**
 * Phase 2E3C5D5 — READ-ONLY source inventory for a pinned Pulse Metrics commit.
 * Does not read environment files, contact PostgreSQL, modify the checkout,
 * make network requests, approve a release, or treat missing grep hits as safety.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEWED_COMMIT = 'f9095d6bcef8428ee877ca2892614146e753ff26';
export const REQUIRED = Object.freeze([
  'server.ts',
  'src/App.tsx',
  'src/agent/run-linux-agent.ts',
  'src/server/historical-store.ts',
  'src/server/auth/workos-auth.ts',
  'src/main.tsx',
  'docs/project/RELEASE-CHECKLIST.md',
  'docs/project/CURRENT-STATUS.md',
  'docs/security/RELEASE-FAILURE-RECOVERY-RUNBOOK.md',
]);

const CHECKS = Object.freeze([
  { id: 'legacy-exec-handler', file: 'server.ts', pattern: /msg\.type\s*===\s*['"]exec_ssh['"]/,
    ifPresent: 'BLOCKER', description: 'Legacy exec_ssh message handler is still in the server source' },
  { id: 'legacy-command-execution', file: 'server.ts', pattern: /exec\(fullCommand\s*,/,
    ifPresent: 'BLOCKER', description: 'Legacy handler still invokes a shell command' },
  { id: 'socket-upgrade-403', file: 'server.ts', pattern: /server\.on\(['"]upgrade['"][\s\S]{0,220}403 Forbidden/,
    ifPresent: 'CONTROL_OBSERVED', description: 'Current HTTP server explicitly rejects WebSocket upgrades' },
  { id: 'prototype-collector-disabled', file: 'server.ts', pattern: /^\s*\/\/\s*startCollector\(\);/m,
    ifPresent: 'CONTROL_OBSERVED', description: 'Legacy collector start call is commented out at reviewed checkpoint' },
  { id: 'prototype-random-metrics', file: 'server.ts', pattern: /Math\.random\s*\(/,
    ifPresent: 'BLOCKER', description: 'Synthetic metric generation code remains in server source' },
  { id: 'fabricated-historical-store', file: 'src/server/historical-store.ts', pattern: /Math\.random\s*\(/,
    ifPresent: 'BLOCKER', description: 'Historical-store source still contains generated measurements' },
  { id: 'browser-ssh-interface', file: 'src/App.tsx', pattern: /SshTerminalDrawer/,
    ifPresent: 'BLOCKER', description: 'React dashboard retains interactive SSH component wiring' },
  { id: 'browser-ws-client', file: 'src/App.tsx', pattern: /new WebSocket\(wsUrl\)/,
    ifPresent: 'INTEGRATION_PENDING', description: 'Browser still attempts WebSocket transport without a working authorized subscription' },
  { id: 'agent-output-terminal-only', file: 'src/agent/run-linux-agent.ts', pattern: /telemetryDestination:\s*['"]local_terminal_only['"]/,
    ifPresent: 'INTEGRATION_PENDING', description: 'Genuine Linux agent outputs locally, not to an authenticated ingest endpoint' },
  { id: 'workos-api-guard', file: 'server.ts', pattern: /app\.use\(['"]\/api['"],\s*requireWorkOSUser\(/,
    ifPresent: 'FOUNDATION_OBSERVED', description: 'Express API has a WorkOS bearer guard for protected API routes' },
  { id: 'organization-routes', file: 'server.ts', pattern: /createCreateOrganizationRoute\(\)/,
    ifPresent: 'FOUNDATION_OBSERVED', description: 'Organization creation route is mounted in the server entrypoint' },
  { id: 'unimplemented-data-apis', file: 'server.ts', pattern: /organization_authorization_pending/,
    ifPresent: 'INTEGRATION_PENDING', description: 'Legacy API fallback explicitly reports authorization integration pending' },
  { id: 'workos-frontend-provider', file: 'src/main.tsx', pattern: /AuthKitProvider/,
    ifPresent: 'FOUNDATION_OBSERVED', description: 'WorkOS AuthKit provider is mounted on the frontend' },
  { id: 'jwt-verification', file: 'src/server/auth/workos-auth.ts', pattern: /verifyAccessToken\(/,
    ifPresent: 'FOUNDATION_OBSERVED', description: 'Server has verified-token authentication code (not a production session audit)' },
  { id: 'status-handover-stale', file: 'docs/project/CURRENT-STATUS.md', pattern: /WorkOS has not yet been integrated|WorkOS AuthKit has been selected but is not integrated/,
    ifPresent: 'DOCUMENTATION_DRIFT', description: 'Project handover states WorkOS integration is pending despite routes/components in tree' },
]);

export function scanSource(sources) {
  if (!sources || typeof sources !== 'object') throw new TypeError('Source inventory must be an object');
  for (const name of REQUIRED) {
    if (typeof sources[name] !== 'string') throw new Error(`REFUSE_AUDIT: required reviewed source unavailable: ${name}`);
  }
  const signals = CHECKS.map(check => {
    const match = check.pattern.exec(sources[check.file]);
    const line = match ? sources[check.file].slice(0, match.index).split('\n').length : null;
    return {
      id: check.id, file: check.file,
      observed: !!match, line,
      interpretation: match ? check.ifPresent : 'NOT_OBSERVED_REVIEW_REQUIRED',
      description: check.description,
    };
  });
  return {
    scope: 'Pinned-source inventory only; not a penetration test or launch certification',
    launchDecision: 'NO_GO',
    launchDecisionReason: 'Public release requires independent operational and end-to-end evidence, regardless of static source findings',
    signals,
  };
}

export function readReviewedSources(root) {
  return Object.fromEntries(REQUIRED.map(name => [name, readFileSync(resolve(root, name), 'utf8')]));
}

function gitOutput(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runCli() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const option = process.argv[2];
  if (process.argv.length > 3 || (option && option !== '--json')) {
    throw new Error('Usage: node scripts/audit/production-readiness.mjs [--json]');
  }
  const head = gitOutput(root, ['rev-parse', 'HEAD']);
  if (head !== REVIEWED_COMMIT) {
    throw new Error(`REFUSE_AUDIT: checkout differs from reviewed commit: ${head}`);
  }
  const branch = gitOutput(root, ['branch', '--show-current']);
  if (branch !== 'feat/identity-organization-onboarding') {
    throw new Error('REFUSE_AUDIT: unexpected Git branch');
  }
  const result = { phase: '2E3C5D5', commit: head, branch, ...scanSource(readReviewedSources(root)) };
  if (option === '--json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`PULSE METRICS — 2E3C5D5 READ-ONLY SOURCE INVENTORY\nReviewed commit: ${head}\n`);
    for (const signal of result.signals) {
      process.stdout.write(`${signal.observed ? 'OBSERVED' : 'REVIEW'} | ${signal.interpretation} | ${signal.id} | ${signal.file}${signal.line ? ':' + signal.line : ''}\n`);
    }
    process.stdout.write(`PUBLIC LAUNCH: ${result.launchDecision}\n`);
    process.stdout.write(`NOTE: ${result.launchDecisionReason}.\n`);
    process.stdout.write('NOTE: Exit 0 means inventory completed, NEVER production readiness. No database access.\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'REFUSE_AUDIT: unknown failure'); process.exitCode = 2; }
}
