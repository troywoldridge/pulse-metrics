import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const dir = dirname(fileURLToPath(import.meta.url));
const path = resolve(dir, 'verify-persistent-foundation.sh');
const source = readFileSync(path, 'utf8');
const safeEnv = { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '', DATABASE_URL: '', MIGRATION_DATABASE_URL: '' };
const execute = (args, env = {}) => spawnSync('bash', [path, ...args], {
  encoding: 'utf8', timeout: 10000, env: {...safeEnv, ...env}, cwd: resolve(dir, '../..'),
});

test('5U-2E1 shell syntax is valid', () => {
  const result = spawnSync('bash', ['-n', path], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('5U-2E1 invalid options refuse before any service operation', () => {
  for(const args of [[], ['--apply'], ['--verify', '--plan'], ['--start']]){
    const r=execute(args);
    assert.notEqual(r.status,0);
    assert.match(r.stderr, /REFUSE_D15C5U2E1/);
  }
});

test('5U-2E1 production mode and inherited database URLs refuse immediately', () => {
  for(const env of [{NODE_ENV:'production'}, {DATABASE_URL:'postgres://bad/path'}, {MIGRATION_DATABASE_URL:'postgres://bad/path'}, {NODE_OPTIONS:'--inspect'}]){
    const r=execute(['--plan'],env);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/REFUSE_D15C5U2E1/);
  }
});

test('5U-2E1 --verify needs separate opt-in before database access', () => {
  const r=execute(['--verify'],{PULSE_APPROVE_5U2E_READ_ONLY:''});
  assert.notEqual(r.status,0);
  if (process.getuid?.() === 0) {
    assert.match(r.stderr,/Non-root Linux operator required/);
  } else {
    assert.match(r.stderr,/read-only verification approval required/);
  }
});

test('5U-2E1 pins exact server path, socket, role and protects quarantine marker', () => {
  for(const token of ['/var/lib/postgresql/pulse-metrics-dev-5u2', '55433', 'data_directory',
    'unix_socket_directories', 'pulse_metrics_app','pulse_metrics_migrator',
    '.pulse-5u2-ready', 'inspect-incomplete-persistent-development.sh']){
    assert.ok(source.includes(token), token);
  }
});

test('5U-2E1 always shuts down and verifies original database after each cycle', () => {
  for(const token of ['trap cleanup EXIT', 'for cycle in 1 2;', 'BEGIN READ ONLY;',
    'pg_ctl', '-m fast -w stop', 'bash "$OFFLINE"',
    'persistent migration receipts identical after PostgreSQL restart']){
    assert.ok(source.includes(token), token);
  }
  assert.doesNotMatch(source, /^\s*(?:rm\s+-rf|DROP\s|CREATE\s|ALTER\s|GRANT\s|REVOKE\s)/mi);
});
