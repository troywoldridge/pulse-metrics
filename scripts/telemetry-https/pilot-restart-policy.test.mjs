/** D15C-5U-2F2E fully offline policy and integration-shape regression tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateRestartEnvironment, validateDatabaseIdentity,
  validateAgentRow, validateReadback, validateDeniedReadback,
} from './pilot-restart-policy.mjs';

const wrapper = fileURLToPath(new URL('../../full-replacements/scripts/telemetry-https/run-postgres-https-subtest.sh', import.meta.url));
const runner = fileURLToPath(new URL('./verify-pilot-after-restart.mjs', import.meta.url));
const source = readFileSync(wrapper, 'utf8');
const verifier = readFileSync(runner, 'utf8');
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const x = '33333333-3333-4333-8333-333333333333';
const y = '44444444-4444-4444-8444-444444444444';
const env = Object.freeze({
  NODE_ENV: 'development', PULSE_D15C5T_ONLY: 'YES',
  PULSE_D15C4_DISPOSABLE_ONLY: 'YES', PULSE_D15C5T_RESTART_VERIFIED: 'YES',
  PULSE_D15C4_SOCKET: '/tmp/pulse-replay-0123456789/socket',
  PULSE_D15C4_DATA: '/tmp/pulse-replay-0123456789/data',
  PULSE_D15C4_ORG_A: a, PULSE_D15C4_ORG_B: b,
  PULSE_D15C5T_OWNER_A: x, PULSE_D15C5T_OWNER_B: y,
});
const history = () => ({ authorized: true, agentFound: true, samples: [{
  recorded_at: new Date('2026-11-16T00:00:00.000Z'),
  received_at: new Date('2026-11-16T00:00:01.000Z'),
  cpu_usage_percent: 0, memory_usage_percent: 51.7, disk_usage_percent: null,
  network_receive_bytes_per_second: '0', network_transmit_bytes_per_second: null,
}] });

test('2F2E complete shell and JavaScript sources parse', () => {
  for (const [command, args] of [
    ['bash', ['-n', wrapper]], ['node', ['--check', runner]],
    ['node', ['--check', fileURLToPath(new URL('./pilot-restart-policy.mjs', import.meta.url))]],
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
test('2F2E requires isolated disposable admission, source path, and two distinct identities', () => {
  const observed = validateRestartEnvironment(env);
  assert.equal(observed.data, env.PULSE_D15C4_DATA);
  assert.notEqual(observed.ownerA, observed.ownerB);
  for (const patch of [
    { PULSE_D15C4_SOCKET: '/var/lib/postgresql/pulse-metrics-dev-5u2/socket' },
    { PULSE_D15C4_DATA: '/var/lib/postgresql/pulse-metrics-dev-5u2/data' },
    { PULSE_D15C4_ORG_B: a }, { PULSE_D15C5T_OWNER_B: x },
    { PULSE_D15C5T_RESTART_VERIFIED: undefined },
    { PULSE_D15C4_DISPOSABLE_ONLY: undefined },
    { PULSE_D15C4_ORG_A: 'not-a-uuid' },
  ]) assert.throws(() => validateRestartEnvironment({ ...env, ...patch }));
});
test('2F2E refuses production, database URL redirects, TLS bypass and Node injection', () => {
  for (const patch of [
    { NODE_ENV: 'production' }, { NODE_OPTIONS: '--inspect' },
    { NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { DATABASE_URL: 'postgres://localhost/test' },
    { MIGRATION_DATABASE_URL: 'postgres://localhost/test' },
    { PGHOST: '/var/run/postgresql' }, { PGPASSWORD: 'untrusted' },
  ]) assert.throws(() => validateRestartEnvironment({ ...env, ...patch }));
});
test('2F2E database identity is restricted and Unix-only', () => {
  validateDatabaseIdentity({ db:'pulse_metrics', role:'pulse_metrics_app', port:'55432', unix_only:true }, env);
  for (const patch of [
    { role: 'postgres' }, { port: '55433' }, { db:'other' },
    { unix_only: false }, { data: '/tmp/trap' },
  ]) assert.throws(() => validateDatabaseIdentity({
    db:'pulse_metrics', role:'pulse_metrics_app', port:'55432', unix_only:true, ...patch,
  }, env));
});
test('2F2E pins one agent and exact lifecycle state after restart', () => {
  assert.equal(validateAgentRow([{id:a,status:'revoked'}],'revoked'),a);
  for (const rows of [[], [{id:a,status:'active'}], [{id:a,status:'revoked'},{id:b,status:'revoked'}],
    [{id:a,status:'revoked',secret:'leak'}], [{id:'bad',status:'revoked'}]]) {
    assert.throws(() => validateAgentRow(rows,'revoked'));
  }
});
test('2F2E accepts honest measured zero and nullable counters on genuine history rows', () => {
  assert.equal(validateReadback(history()), true);
  const another = history();
  another.samples[0].memory_usage_percent = null;
  another.samples[0].network_receive_bytes_per_second = '123456789';
  assert.equal(validateReadback(another), true);
});
test('2F2E fails closed on extra rows, private fields, invalid values and timestamps', () => {
  const mutate = [
    r => r.samples.push(history().samples[0]),
    r => { r.samples[0].metrics = {raw:'secret'}; },
    r => { r.samples[0].cpu_usage_percent = 110; },
    r => { r.samples[0].network_receive_bytes_per_second = -1; },
    r => { r.samples[0].network_receive_bytes_per_second = 1.25; },
    r => { r.samples[0].recorded_at = '2026-11-16'; },
    r => { r.agentFound = false; },
    r => { r.samples = []; },
  ];
  for (const change of mutate) { const value = history(); change(value); assert.throws(() => validateReadback(value)); }
});
test('2F2E foreign member and foreign agent are denied without data', () => {
  validateDeniedReadback({authorized:false,agentFound:false,samples:[]});
  validateDeniedReadback({authorized:true,agentFound:false,samples:[]},true);
  assert.throws(() => validateDeniedReadback({authorized:true,agentFound:true,samples:[]}));
  assert.throws(() => validateDeniedReadback({authorized:false,agentFound:false,samples:[{}]}));
});
test('2F2E wrapper restarts only disposable PostgreSQL with parent cleanup retained', () => {
  assert.match(source, /\/tmp\/pulse-replay-/);
  assert.match(source, /pulse-telemetry-agent-quota-marker/);
  assert.match(source, /-m fast -w stop/);
  assert.match(source, /-w start/);
  assert.match(source, /pg_postmaster_start_time\(\)/);
  assert.match(source, /verify_disposable_identity/);
  assert.match(source, /PULSE_D15C5T_RESTART_VERIFIED=YES/);
  assert.match(source, /verify-pilot-after-restart\.mjs/);
  assert.doesNotMatch(source, /pulse-metrics-dev-5u2/);
  assert.doesNotMatch(source, /\b(?:nginx|pm2|cloudflared|ssh|scp)\b/);
});
test('2F2E post-restart auditor verifies RLS, revoked agent, no secrets and clean pool state', () => {
  assert.match(verifier, /BEGIN READ ONLY/);
  assert.match(verifier, /ROLLBACK/);
  assert.match(verifier, /'app\.current_user_id'/);
  assert.match(verifier, /'app\.current_organization_id'/);
  assert.match(verifier, /readDisposableTenantHistory/);
  assert.match(verifier, /'revoked'/);
  assert.match(verifier, /'active'/);
  assert.match(verifier, /42501/);
  assert.match(verifier, /client\.release\(provedClean && !failed/);
  assert.doesNotMatch(verifier, /\b(?:INSERT|DELETE|UPDATE|TRUNCATE|CREATE|ALTER)\b/i);
});
