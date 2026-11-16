/** D15C-5U-2F2F offline source, contract and fail-closed argument tests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const shellPath = resolve(root, 'scripts/telemetry-persistent/rehearse-nonzero-pilot-audit.sh');
const sqlPath = resolve(root, 'scripts/telemetry-persistent/nonzero-pilot-ledger.sql');
const activeRunner = resolve(root, 'scripts/telemetry-https/run-postgres-https-subtest.sh');
const launcherPath = existsSync(activeRunner) ? activeRunner :
  resolve(root, 'full-replacements/scripts/telemetry-https/run-postgres-https-subtest.sh');
const shell = readFileSync(shellPath, 'utf8');
const sql = readFileSync(sqlPath, 'utf8');
const launcher = readFileSync(launcherPath, 'utf8');
const digest = text => createHash('sha256').update(text).digest('hex');
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', NODE_ENV: 'development' });
function run(args, patchEnv = {}, source = shellPath) {
  return spawnSync('bash', [source, ...args], {
    cwd: root,
    env: { ...cleanEnv(), ...patchEnv },
    encoding: 'utf8', timeout: 5000,
  });
}

test('2F2F full shell launcher parses and source identities are pinned', () => {
  for (const file of [shellPath, launcherPath]) {
    const x = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(x.status, 0, x.stderr);
  }
  assert.match(shell, /SQL_SHA='c7861e43faae020a5e8d4de0f83509a277c1960694369a7db90631f7d5a9f862'/);
  assert.equal(digest(sql), 'c7861e43faae020a5e8d4de0f83509a277c1960694369a7db90631f7d5a9f862');
});

test('2F2F plan is offline, explicit and does not open or start PostgreSQL', () => {
  const x = run(['--plan']);
  assert.equal(x.status, 0, x.stderr);
  assert.match(x.stdout, /READ-ONLY|READ ONLY/);
  assert.match(x.stdout, /port 55433.*NEVER|port 55433.*not/i);
  assert.doesNotMatch(x.stdout, /AUDIT: PASS/);
});

test('2F2F refuses missing, duplicate and unknown command modes', () => {
  for (const args of [[], ['--audit'], ['--plan','--audit-disposable'], ['--start'], ['--stop'], ['--verify'], ['--audit-disposable','--plan']]) {
    assert.notEqual(run(args).status, 0, `${args.join(' ')} accepted`);
  }
});

test('2F2F fails closed on production, inherited DB URLs and Node injection', () => {
  for (const patch of [
    { NODE_ENV: 'production' }, { DATABASE_URL: 'postgres://localhost/pulse_metrics' },
    { MIGRATION_DATABASE_URL: 'postgres://localhost/pulse_metrics' },
    { NODE_OPTIONS: '--require=/tmp/other.js' },
    { NODE_EXTRA_CA_CERTS: '/tmp/unverified.pem' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { PULSE_ENABLE_PUBLIC_INGRESS: 'YES' },
    { PULSE_ENABLE_TELEMETRY_SERVICE: 'YES' },
  ]) assert.notEqual(run(['--audit-disposable'], patch).status, 0, JSON.stringify(patch));
});

test('2F2F without approved disposable post-restart gate fails before sudo', () => {
  const x = run(['--audit-disposable']);
  assert.notEqual(x.status, 0);
  assert.match(x.stderr, /Disposable post-restart admission missing/);
});

test('2F2F refuses forged socket, protected persistent port and invalid organization identities', () => {
  const admission = { PULSE_D15C5T_ONLY: 'YES', PULSE_D15C4_DISPOSABLE_ONLY: 'YES', PULSE_D15C5T_RESTART_VERIFIED: 'YES' };
  for (const e of [
    { PULSE_D15C4_SOCKET: '/var/lib/postgresql/pulse-metrics-dev-5u2/socket' },
    { PULSE_D15C4_SOCKET: '/tmp/pulse-replay-ABCDEFGHIJ/socket', PULSE_D15C4_DATA: '/var/lib/postgresql/pulse-metrics-dev-5u2/data' },
    { PULSE_D15C4_SOCKET: '/tmp/pulse-replay-ABCDEFGHIJ/socket', PULSE_D15C4_DATA: '/tmp/pulse-replay-ABCDEFGHIJ/data', PULSE_D15C4_ORG_A: 'not-a-uuid' },
  ]) assert.notEqual(run(['--audit-disposable'], { ...admission, ...e }).status, 0);
  assert.match(shell, /PORT|55432/);
  assert.match(shell, /unix_socket_directories/);
});

test('2F2F refuses altered SQL before attempting database operation', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'pulse-2f2f-hash-'));
  const p = resolve(tmp, 'scripts/telemetry-persistent');
  mkdirSync(p, { recursive: true });
  copyFileSync(shellPath, resolve(p, 'rehearse-nonzero-pilot-audit.sh'));
  writeFileSync(resolve(p, 'nonzero-pilot-ledger.sql'), sql + '\n-- tampered\n');
  try {
    const x = run(['--plan'], {}, resolve(p, 'rehearse-nonzero-pilot-audit.sh'));
    assert.notEqual(x.status, 0);
    assert.match(x.stderr, /Reviewed SQL changed/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('2F2F SQL is transactionally read-only and pins exact database identity', () => {
  assert.match(sql, /BEGIN READ ONLY;/);
  assert.match(sql, /COMMIT;/);
  assert.match(sql, /transaction_read_only/);
  assert.match(sql, /current_user <> 'postgres'/);
  assert.match(sql, /current_setting\('port'\) <> '55432'/);
  assert.match(sql, /inet_server_addr\(\) IS NOT NULL/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\s+(?:INTO\s+|TABLE\s+|FUNCTION\s+)?(?:public\.|pulse_telemetry_)/i);
});

test('2F2F validates nonzero ledger bidirectionally, not only foreign keys', () => {
  assert.match(sql, /count\(\*\) FROM public\.telemetry_samples\) <> 246/);
  assert.match(sql, /count\(\*\) FROM pulse_telemetry_ingestion\.submissions\) <> 246/);
  assert.match(sql, /LEFT JOIN pulse_telemetry_ingestion\.submissions s/);
  assert.match(sql, /s\.telemetry_sample_id = t\.id/);
  assert.match(sql, /s\.telemetry_sample_id IS NULL/);
  assert.match(sql, /t\.organization_id IS DISTINCT FROM s\.organization_id/);
  assert.match(sql, /t\.agent_id IS DISTINCT FROM s\.agent_id/);
});

test('2F2F verifies genuine agent ownership, revocation and restrictive permissions', () => {
  for (const match of [/d15c5t-a\.invalid/, /d15c5t-b\.invalid/, /status = 'revoked'/,
    /status = 'active'/, /memory\.total_bytes/, /revoked_at IS NULL/,
    /revoked_at IS NOT NULL/, /telemetry:write/, /FORCE RLS regressed/,
    /least-privilege boundary regressed/]) assert.match(sql, match);
});

test('2F2F complete replacement preserves exact prior rehearsal source and runs audit last', () => {
  const marker = '\n# D15C-5U-2F2F — independent READ-ONLY nonzero ledger contract';
  const index = launcher.indexOf(marker);
  assert.ok(index > 0);
  assert.equal(digest(launcher.slice(0, index)), 'adfa2bf1f92d3c7e6d2b509dd4204822f29194cc39b5d020bb0f4d5aec4ca472');
  assert.match(launcher.slice(index), /PULSE_D15C5T_RESTART_VERIFIED=YES/);
  assert.match(launcher.slice(index), /rehearse-nonzero-pilot-audit\.sh --audit-disposable/);
  assert.ok(launcher.indexOf('RESULT=') < index);
});
