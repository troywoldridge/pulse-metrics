#!/usr/bin/env node
/**
 * D15C-5U-2C — test the actual new SQL artifacts in an independently disposable
 * PostgreSQL rehearsal. The original test runner and SQL sources are UNCHANGED.
 * Never connects to the persistent 5U-2 development database.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, SPECS, buildCandidates, verifyOutputs } from './release-candidates.mjs';

function refuse(message) { throw new Error(`REFUSE_5U2C_DISPOSABLE_TEST: ${message}`); }
function replaceOnce(text, search, replacement) {
  if (!text.includes(search) || text.indexOf(search) !== text.lastIndexOf(search)) {
    refuse('original rehearsal layout changed; no derived runner created');
  }
  return text.replace(search, replacement);
}
function toShellSingleQuote(str) {
  return `'${str.replaceAll("'", "'\\''")}'`;
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') refuse('Use exactly --run');
  if (process.env.PULSE_APPROVE_5U2C_DISPOSABLE_REHEARSAL !== 'YES' ||
      process.env.NODE_ENV === 'production' || process.env.NODE_OPTIONS ||
      process.env.DATABASE_URL || process.env.MIGRATION_DATABASE_URL ||
      process.platform !== 'linux' || (process.getuid?.() ?? 0) === 0) {
    refuse('explicit nonproduction disposable-test approval and non-root Linux operator required');
  }
  const root = realpathSync(ROOT);
  if (!root.endsWith('/pulse-metrics')) refuse('unexpected repository root; no test run');
  const sourcePath = join(root, 'scripts/test-telemetry-agent-quota-http-rehearsal.sh');
  if (!existsSync(sourcePath)) refuse('original disposable rehearsal script missing');
  const diff = spawnSync('git', ['diff', '--quiet', 'HEAD', '--',
    'scripts/test-telemetry-agent-quota-http-rehearsal.sh',
    ...SPECS.map(spec => spec.source)], { cwd: root, stdio: 'ignore' });
  if (diff.status !== 0) refuse('original committed rehearsal or SQL sources changed');
  const items = verifyOutputs(root, buildCandidates(root));
  const offline = join(root, 'scripts/telemetry-dev/inspect-incomplete-persistent-development.sh');
  if (!existsSync(offline)) refuse('required guarded offline persistent-cluster inspector missing');
  console.log('========== VERIFY QUARANTINED PERSISTENT CLUSTER IS STOPPED ==========');
  const before = spawnSync('bash', [offline], { cwd: root, stdio: 'inherit' });
  if (before.error || before.status !== 0) refuse('quarantined cluster failed pre-rehearsal offline inspection');
  let runner = readFileSync(sourcePath, 'utf8');
  const oldRoot = 'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"';
  runner = replaceOnce(runner, oldRoot, `ROOT=${toShellSingleQuote(root)}`);
  const [network, agent, credential] = items;
  const subs = [
    ["QUOTA_SQL='scripts/telemetry-quota/migrations/0001_telemetry_network_quota.sql'", `QUOTA_SQL='${network.spec.target}'`],
    [`QUOTA_HASH='${network.sourceHash}'`, `QUOTA_HASH='${network.targetHash}'`],
    ["AGENT_SQL='scripts/telemetry-agent-quota/migrations/0001_telemetry_agent_quota.sql'", `AGENT_SQL='${agent.spec.target}'`],
    [`AGENT_HASH='${agent.sourceHash}'`, `AGENT_HASH='${agent.targetHash}'`],
    ["AUTH_SQL='scripts/telemetry-auth-outcome/migrations/0002_machine_credential_rejection.sql'", `AUTH_SQL='${credential.spec.target}'`],
    [`AUTH_EXPECTED='${credential.sourceHash}'`, `AUTH_EXPECTED='${credential.targetHash}'`],
  ];
  for (const [before, after] of subs) runner = replaceOnce(runner, before, after);
  // This is a derived *full-file* runner in /tmp. Its source is never edited.
  const directory = mkdtempSync(join(tmpdir(), 'pulse-5u2c-rehearsal-'));
  const script = join(directory, 'run-full-disposable.sh');
  try {
    chmodSync(directory, 0o700);
    writeFileSync(script, runner, { mode: 0o600, flag: 'wx' });
    console.log('========== EXECUTE DISPOSABLE FULL POSTGRESQL REHEARSAL USING NEW DEV SQL CANDIDATES ==========');
    console.log('The canonical committed rehearsal and its SQL inputs are never changed.');
    const result = spawnSync('bash', [script], {
      cwd: root, stdio: 'inherit', timeout: 900000,
      env: { ...process.env, PULSE_5U2C_DISPOSABLE_ONLY: 'YES' },
    });
    console.log('========== RECHECK QUARANTINED PERSISTENT CLUSTER AND ORIGINAL DATABASE ==========');
    const after = spawnSync('bash', [offline], { cwd: root, stdio: 'inherit' });
    if (after.error || after.status !== 0) refuse('quarantined cluster failed post-rehearsal inspection');
    if (result.error || result.status !== 0) {
      refuse('derived disposable PostgreSQL rehearsal failed; persistent database is NOT authorized');
    }
    console.log('PASS: new dev SQL candidates exercised against genuine disposable PostgreSQL integration tests');
    console.log('PERSISTENT CLUSTER UNTOUCHED | PUBLIC LAUNCH NO_GO');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try { main(); }
catch (e) {
  console.error(e instanceof Error ? e.message : 'REFUSE_5U2C_DISPOSABLE_TEST');
  process.exitCode = 1;
}
