import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const dir = dirname(fileURLToPath(import.meta.url));
const target = join(dir, 'local-development-postgres.sh');
const source = readFileSync(target, 'utf8');
function invoke(args = [], extra = {}) {
  return spawnSync('bash', [target, ...args], {
    encoding: 'utf8', timeout: 4000,
    env: { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '', DATABASE_URL: '', MIGRATION_DATABASE_URL: '', ...extra },
  });
}
test('entire Bash file has valid syntax', () => {
  const p = spawnSync('bash', ['-n', target], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
});
test('unknown, missing and multi-argument modes refuse before any DB access', () => {
  for (const args of [[], ['--apply'], ['--start', '--stop'], ['--ready'], ['--verify']]) {
    const p = invoke(args);
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /REFUSE_D15C5U2F1/);
    assert.doesNotMatch(p.stdout, /START VERIFIED/);
  }
});
test('production, inherited database URLs and Node runtime injection refuse', () => {
  for (const bad of [
    { NODE_ENV: 'production' },
    { NODE_OPTIONS: '--inspect' },
    { DATABASE_URL: 'postgresql://example.invalid/pulse_metrics' },
    { MIGRATION_DATABASE_URL: 'postgresql://example.invalid/pulse_metrics' },
    { PULSE_ENABLE_PUBLIC_INGRESS: 'YES' },
  ]) {
    const p = invoke(['--start'], bad);
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /REFUSE_D15C5U2F1/);
  }
});
test('starting requires separate exact local-only approval', () => {
  assert.match(source, /PULSE_APPROVE_5U2F_LOCAL_START/);
  assert.match(source, /EXACT_SOCKET_ONLY/);
  const p = invoke(['--start']);
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /Linux non-root operator required|Separate EXACT_SOCKET_ONLY approval/);
});
test('local target is pinned and refuses any ready marker', () => {
  for (const term of [
    "/var/lib/postgresql/pulse-metrics-dev-5u2",
    "PORT=55433",
    "OFFLINE_SHA='7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'",
    ".pulse-5u2-provisioning",
    ".pulse-5u2-ready",
    "host all all 0.0.0.0/0 reject",
    "host all all ::/0 reject",
  ]) assert.ok(source.includes(term), term);
  assert.doesNotMatch(source, /(touch|printf[^\n]*>|cat[^\n]*>)[^\n]*\.pulse-5u2-ready/);
});
test('live identity and security checks protect against unexpected migrations or data', () => {
  for (const term of [
    "current_setting('data_directory')",
    "current_setting('listen_addresses')",
    'BEGIN READ ONLY',
    "pulse_telemetry_agent_quota.schema_migrations",
    'relforcerowsecurity',
    'pulse_metrics_app',
    'SET ROLE pulse_metrics_app',
    '42501:',
    'pulse_telemetry_ingestion.ingest_submission(',
    'public.telemetry_samples',
  ]) assert.ok(source.includes(term), term);
});
test('start failure shuts down; successful start leaves local cluster running; stop checks offline baseline', () => {
  assert.match(source, /if \(\( ! SUCCESS && START_ATTEMPTED \)\)/);
  assert.match(source, /pg_ctl" -D "\$DATA" -m fast -w stop/);
  assert.match(source, /SUCCESS=1/);
  assert.match(source, /bash "\$OFFLINE"/);
  assert.match(source, /No API started \| No agent enrolled \| No ready marker/);
});
