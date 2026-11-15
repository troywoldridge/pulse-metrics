import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const script = resolve(root, 'recover-quarantined-development.sh');
const source = readFileSync(script, 'utf8');

function invoke(args, env = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, NODE_ENV: 'development', ...env },
  });
}

test('recovery script has valid Bash syntax', () => {
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('refuses ambiguous, missing and unrecognized CLI modes before any tool use', () => {
  for (const flags of [[], ['--resume'], ['--apply', '--plan'], ['--delete']]) {
    const result = invoke(flags);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSE_D15C5U2D/);
  }
});

test('refuses production and inherited database URLs before system inspection', () => {
  for (const env of [
    { NODE_ENV: 'production' },
    { DATABASE_URL: 'postgresql://example.invalid/test' },
    { MIGRATION_DATABASE_URL: 'postgresql://example.invalid/test' },
    { NODE_OPTIONS: '--trace-warnings' },
  ]) {
    const result = invoke(['--plan'], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSE_D15C5U2D/);
  }
});

test('requires explicit schema-only approval and fixed Unix socket identity', () => {
  assert.match(source, /PULSE_APPROVE_5U2D_PARTIAL_RELEASE/);
  assert.match(source, /THREE_MIGRATIONS_ONLY/);
  assert.match(source, /\/var\/lib\/postgresql\/pulse-metrics-dev-5u2/);
  assert.match(source, /PORT=55433/);
  assert.match(source, /current_setting\('data_directory'\)/);
  assert.match(source, /inet_server_addr\(\) IS NOT NULL/);
  assert.match(source, /BEGIN READ ONLY;/);
});

test('source validation and quarantine inventory run before any migration', () => {
  const verify = source.indexOf('node "$GENERATOR" --verify');
  const inspector = source.indexOf('bash "$SQL_INVENTORY"');
  const strictSql = source.indexOf('STRICT PARTIAL DATABASE PREFLIGHT');
  const apply = source.indexOf('APPLY ONLY THREE NEW DEVELOPMENT SQL MIGRATIONS');
  assert.ok(verify >= 0 && inspector > verify && strictSql > inspector && apply > strictSql);
  assert.match(source, /scripts\/migrations\/ledger-audit\.sql/);
  assert.match(source, /scripts\/telemetry-ingestion\/release-permission-gate\.sql/);
  assert.match(source, /recorded_mode='fresh_replay'/);
  assert.match(source, /'588783991e63bc975f774692fc6732c80ac2e9070b33c93bea43c503e31f2f1f'/);
});

test('migration order fixed and installation remains schema-only', () => {
  const p = source.indexOf('0001_network_quota_dev_candidate.sql');
  const q = source.indexOf('0002_agent_quota_dev_candidate.sql');
  const r = source.indexOf('0003_credential_outcome_dev_candidate.sql');
  assert.ok(p > 0 && q > p && r > q);
  assert.doesNotMatch(source, /(?:rm\s+-rf|CREATE ROLE|CREATE DATABASE|CREATE ORGANIZATION)/i);
  assert.doesNotMatch(source, /tee\s+.*\.pulse-5u2-ready/);
  assert.match(source, /START_ATTEMPTED=1/);
  assert.match(source, /pg_ctl.*-m fast -w stop/);
  assert.match(source, /NO READY MARKER OR AGENT ACTIVATION/);
});
