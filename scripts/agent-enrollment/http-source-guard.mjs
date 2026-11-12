#!/usr/bin/env node
/**
 * Phase 2E3C5D8: narrow reviewability/static regression guard ONLY.
 * Source invariants are not a substitute for HTTP/DB integration or release review.
 * No database, environment file, process invocation or network interaction.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BASELINE = '89e86acc409a44c75671de2cfb29c4e6b0159ac0';
export const PROTECTED = Object.freeze({
  'server.ts': 'b60547bda0c88d5f3976cba905ede367b38e9581',
  'src/db/schema.ts': 'cbdfb4e73f93fecc5c7460c63775e179e0bf66cd',
  'src/main.tsx': 'ef12bb11e4796b05c4e57a07af0c1cfeddffedba',
  'src/server/legacy-transport.ts': '5c23c0fad94df7cbe7c0323955e32d06cb71d8e0',
  'src/agent/run-linux-agent.ts': '6864599b0404aa0f1219344c862c40ec415e92a9',
  'src/server/auth/workos-auth.ts': '21e3b48a4c26f88f0ca261657cae9294bce1e287',
  'scripts/migrations/privileged-manifest.json': '41f8c2db16b04f742d36afa1e77c4e823e2cf2a6',
});
export const ADDED = Object.freeze([
  'src/server/agent-enrollment-service.ts',
  'src/server/agent-enrollment-routes.ts',
  'src/server/agent-enrollment-routes.test.ts',
  'scripts/agent-enrollment/http-integration.ts',
  'scripts/agent-enrollment/http-source-guard.mjs',
  'scripts/agent-enrollment/http-source-guard.test.mjs',
  'scripts/test-agent-enrollment-http-rehearsal.sh',
  'docs/security/AGENT-ENROLLMENT-HTTP-FOUNDATION.md',
]);

export function checkContract(sources) {
  const required = {
    'src/server/agent-enrollment-service.ts': [
      /createEnrollmentMaterial\(/,
      /createAgentSecretMaterial\(/,
      /hashAgentSecret\(/,
      /async issue\(/,
      /async redeem\(/,
    ],
    'src/server/agent-enrollment-routes.ts': [
      /createIssueAgentEnrollmentRoute\(service: AgentEnrollmentService\)/,
      /createRedeemAgentEnrollmentRoute\(service: AgentEnrollmentService\)/,
      /isVerifiedActor\(identity\)/,
      /agentEnrollmentIngressVerified/,
      /res\.status\(401\)/,
      /res\.status\(403\)/,
      /res\.status\(404\)/,
      /res\.status\(503\)/,
      /Cache-Control', 'no-store'/,
    ],
    'scripts/agent-enrollment/http-integration.ts': [
      /pulse_agent_rehearsal\.issue_enrollment/,
      /pulse_agent_rehearsal\.redeem_enrollment/,
      /Promise\.all\(/,
      /\[201, 404\]/,
    ],
  };
  const results = [];
  for (const [file, rules] of Object.entries(required)) {
    if (typeof sources[file] !== 'string') {
      results.push({ file, passed: false, message: 'Missing source' });
      continue;
    }
    const missing = rules.filter(rule => !rule.test(sources[file]));
    results.push({ file, passed: missing.length === 0,
      message: missing.length ? 'Required contract evidence missing' : 'Required contract evidence observed' });
  }
  // Never mistake source absence for security: no live endpoint is enabled.
  const live = sources['server.ts'];
  const frontend = sources['src/main.tsx'];
  results.push({ file: 'server.ts', passed: typeof live === 'string' &&
    !/createIssueAgentEnrollmentRoute|createRedeemAgentEnrollmentRoute|agent-enrollments\//.test(live),
  message: 'Public enrollment route is not mounted' });
  results.push({ file: 'src/main.tsx', passed: typeof frontend === 'string' &&
    /AuthenticatedBoundary/.test(frontend) && !/agent-enrollment-routes/.test(frontend),
  message: 'WorkOS holding boundary stays mounted' });
  return results;
}

function run() {
  const opts = process.argv.slice(2);
  if (opts.length > 1 || (opts[0] && opts[0] !== '--json')) {
    throw new Error('Usage: node scripts/agent-enrollment/http-source-guard.mjs [--json]');
  }
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (branch !== 'feat/identity-organization-onboarding') throw new Error('Unexpected branch');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (sha !== BASELINE) throw new Error('Reviewed source checkpoint changed; require a new review');
  for (const [file, expected] of Object.entries(PROTECTED)) {
    const path = resolve(ROOT, file);
    if (!existsSync(path)) throw new Error('Protected source missing: ' + file);
    const actual = execFileSync('git', ['hash-object', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (actual !== expected) throw new Error('Protected source modified: ' + file);
  }
  const files = [...ADDED, 'server.ts', 'src/main.tsx'];
  const sources = Object.fromEntries(files.map(f => [f, readFileSync(resolve(ROOT, f), 'utf8')]));
  const checks = checkContract(sources);
  if (checks.some(c => !c.passed)) throw new Error('HTTP contract source audit failed: ' + checks.filter(c=>!c.passed).map(c=>c.file).join(','));
  const status = { phase: '2E3C5D8', reviewedCommit: BASELINE, sourceChecks: checks,
    liveApiEnabled: false, liveMigrationApplied: false, publicLaunch: 'NO_GO' };
  if (opts[0] === '--json') process.stdout.write(JSON.stringify(status,null,2)+'\n');
  else {
    console.log('========== PHASE 2E3C5D8 READ-ONLY HTTP FOUNDATION AUDIT ==========');
    for (const c of checks) console.log('PASS: ' + c.file + ' — ' + c.message);
    console.log(`PASS: ${Object.keys(PROTECTED).length} unchanged protected Git sources`);
    console.log('PUBLIC LAUNCH: NO_GO | HTTP handlers intentionally UNMOUNTED');
    console.log('NOTE: source audit is not TLS/rate-limit/database-production certification');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown audit error');
    process.exitCode = 1;
  }
}
