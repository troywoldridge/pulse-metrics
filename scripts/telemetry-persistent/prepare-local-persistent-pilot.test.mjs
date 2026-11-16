/** D15C-5U-2F2D offline checks. These tests never connect to PostgreSQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('./prepare-local-persistent-pilot.sh', import.meta.url));
const source = readFileSync(target, 'utf8');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  NODE_OPTIONS: '', DATABASE_URL: '', MIGRATION_DATABASE_URL: '',
  NODE_EXTRA_CA_CERTS: '', NODE_TLS_REJECT_UNAUTHORIZED: '1',
  PULSE_ENABLE_PUBLIC_INGRESS: '', PULSE_ENABLE_TELEMETRY_SERVICE: '',
  PULSE_D15C5U_LOCAL_ONLY: '', PULSE_APPROVE_5U2F2D_READ_ONLY_AUDIT: '',
};
const run = (args, change = {}) => spawnSync('bash', [target, ...args], {
  encoding: 'utf8', timeout: 5000, env: { ...env, ...change },
});

test('5U-2F2D entire script has valid Bash syntax', () => {
  const r = spawnSync('bash', ['-n', target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('5U-2F2D refuses missing, extra or unknown modes before operations', () => {
  for (const args of [[], ['--create'], ['--write'], ['--audit', '--verify'], ['--ready'], ['--enroll']]) {
    const r = run(args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /REFUSE_D15C5U2F2D/);
    assert.doesNotMatch(r.stdout, /CONTROLLED ZERO-DATA|REVERIFY/);
  }
});

test('5U-2F2D refuses production, inherited DB URLs, TLS override and service switches', () => {
  for (const change of [
    { NODE_ENV: 'production' }, { NODE_OPTIONS: '--inspect' },
    { DATABASE_URL: 'postgres://example.invalid/db' },
    { MIGRATION_DATABASE_URL: 'postgres://example.invalid/db' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { NODE_EXTRA_CA_CERTS: '/tmp/example.pem' },
    { PULSE_ENABLE_PUBLIC_INGRESS: 'YES' },
    { PULSE_ENABLE_TELEMETRY_SERVICE: 'YES' },
    { PULSE_D15C5U_LOCAL_ONLY: 'YES' },
  ]) {
    const r = run(['--plan'], change);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /REFUSE_D15C5U2F2D/);
  }
});

test('5U-2F2D live start requires separate exact approval before sudo', () => {
  for (const approval of ['', 'YES', 'START_AUDIT_STOP_ZERO_ROWS ']) {
    const r = run(['--audit'], { PULSE_APPROVE_5U2F2D_READ_ONLY_AUDIT: approval });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Non-root Linux operator|Separate START_AUDIT_STOP_ZERO_ROWS approval/);
    assert.doesNotMatch(r.stdout, /CONTROLLED ZERO-DATA/);
  }
});

test('5U-2F2D plan contains no invocations or operational side effects', () => {
  assert.match(source, /if \[\[ "\$MODE" == --plan \]\]; then/);
  const plan = source.indexOf('if [[ "$MODE" == --plan ]]');
  const stop = source.indexOf('exit 0', plan);
  const resolve = source.indexOf('ROOT=', plan);
  assert.ok(plan > 0 && stop > plan && resolve > stop);
  assert.match(source, /PERSISTENT WRITES \| PUBLIC LAUNCH: NO_GO/);
});

test('5U-2F2D checks exact source identity, eight pinned files and expected Git branch', () => {
  assert.match(source, /\$HOME\/Projects\/pulse-metrics/);
  assert.match(source, /feat\/identity-organization-onboarding/);
  for (const name of [
    'local-development-postgres.sh', 'retained-local-cold-snapshot.sh',
    'verify-retained-cold-restore.sh', 'inspect-incomplete-persistent-development.sh',
    'release-candidates.mjs', 'local-dev-one-shot.ts',
    'disposable-tenant-history.mjs', 'verify-sender-to-postgres.mjs',
  ]) assert.ok(source.includes(name), name);
  assert.equal((source.match(/check_pin \"\$/g) ?? []).length, 8);
});

test('5U-2F2D verify checks migration candidates, stopped source and backup without starting PostgreSQL', () => {
  assert.match(source, /node "\$RELEASE" --verify/);
  assert.match(source, /bash "\$OFFLINE" \|\| refuse/);
  assert.match(source, /bash "\$BACKUP" --verify \|\| refuse/);
  const verify = source.indexOf('if [[ "$MODE" == --verify ]]');
  const exit = source.indexOf('exit 0', verify);
  const live = source.indexOf('CONTROLLED ZERO-DATA DEVELOPMENT DATABASE AUDIT', verify);
  assert.ok(verify > 0 && exit > verify && live > exit);
});

test('5U-2F2D audited startup uses existing zero-row operator and mandatory targeted stop', () => {
  assert.match(source, /PULSE_APPROVE_5U2F_LOCAL_START=EXACT_SOCKET_ONLY bash "\$OPERATOR" --start/);
  assert.match(source, /bash "\$OPERATOR" --audit/);
  assert.match(source, /bash "\$OPERATOR" --status/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /sudo -u postgres "\$PG_BIN\/pg_ctl" -D "\$PG_DATA" status/);
  assert.match(source, /bash "\$OPERATOR" --stop/);
  assert.match(source, /bash "\$BACKUP" --verify \|\| result=1/);
});

test('5U-2F2D never creates readiness markers, enrollment fixtures, public routes or telemetry samples', () => {
  assert.doesNotMatch(source, /\b(?:CREATE|INSERT|UPDATE|DELETE|ALTER)\s+(?:TABLE|ROLE|INTO|FROM|FUNCTION)\b/);
  assert.doesNotMatch(source, /\b(?:curl|wget|ssh|scp|nginx|pm2)\b/);
  assert.doesNotMatch(source, /\.pulse-5u2-ready/);
  assert.match(source, /no telemetry writes authorized/);
  assert.match(source, /zero-row/);
});
