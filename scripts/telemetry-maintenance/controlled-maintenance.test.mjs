import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAINTENANCE_POLICY, assertMaintenanceIdentity, runControlledMaintenance,
} from './controlled-maintenance-policy.mjs';

const DATA = '/tmp/pulse-replay-ABCDEFGHIJ/data';
const goodIdentity = Object.freeze({
  db: 'pulse_metrics', role: 'pulse_metrics_test_maintainer',
  session_role: 'pulse_metrics_test_maintainer', local_only: true,
  port: '55432', tcp_disabled: true,
});
const reply = x => ({ rowCount: 1, rows: [x] });
function mock({ identity = goodIdentity, lock = true, batches = [],
                errorOn = '', unlock = true } = {}) {
  let count = 0;
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (errorOn && sql.includes(errorOn)) throw Error('SECRET_DATABASE_URL postgres://secret:password@host');
      if (sql.includes('AS tcp_disabled')) return reply(identity);
      if (sql.includes('pg_try_advisory_lock')) return reply({ acquired: lock });
      if (sql.includes('prune_expired_quota_buckets()'))
        return reply(batches[count++] ?? { network_removed: 0, agent_removed: 0 });
      if (sql.includes('pg_advisory_unlock')) return reply({ released: unlock });
      throw Error('unexpected SQL');
    },
  };
}

test('D15C-5C bounded cleanup succeeds and releases session lock', async () => {
  const db = mock({ batches: [
    { network_removed: 250, agent_removed: 250 },
    { network_removed: 15, agent_removed: 15 },
    { network_removed: 0, agent_removed: 0 },
  ] });
  const events = [];
  const result = await runControlledMaintenance(db, DATA, e => events.push(e));
  assert.deepEqual(result, { status: 'completed', batches: 3,
    networkRemoved: 265, agentRemoved: 265, possibleBacklog: false });
  assert.deepEqual(events.map(e => e.event), [
    'maintenance_started', 'batch_completed', 'batch_completed',
    'batch_completed', 'maintenance_completed',
  ]);
  assert.equal(db.queries.filter(q => q.sql.includes('FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()')).length, 3);
  assert.equal(db.queries.filter(q => q.sql.includes('pg_advisory_unlock')).length, 1);
});

test('D15C-5C overlapping worker refuses without cleanup', async () => {
  const db = mock({ lock: false }); const events = [];
  const result = await runControlledMaintenance(db, DATA, e => events.push(e));
  assert.deepEqual(result, { status: 'overlap_skipped' });
  assert.deepEqual(events, [{ event: 'overlap_skipped', alert: false }]);
  assert.equal(db.queries.some(q => q.sql.includes('FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()')), false);
});

test('D15C-5C absolute three-batch ceiling produces review signal', async () => {
  const db = mock({ batches: Array(5).fill({ network_removed: 250, agent_removed: 250 }) });
  const events = [];
  const result = await runControlledMaintenance(db, DATA, e => events.push(e));
  assert.equal(result.networkRemoved, 750);
  assert.equal(result.agentRemoved, 750);
  assert.equal(result.batches, MAINTENANCE_POLICY.maximumBatches);
  assert.equal(result.possibleBacklog, true);
  assert.equal(events.at(-1).alert, true);
  assert.equal(db.queries.filter(q => q.sql.includes('FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()')).length, 3);
});

test('D15C-5C refuses untrusted role and socket identity before lock', async () => {
  const db = mock({ identity: { ...goodIdentity, session_role: 'pulse_metrics_app' } });
  const events = [];
  assert.deepEqual(await runControlledMaintenance(db, DATA, e => events.push(e)), { status: 'failed' });
  assert.deepEqual(events, [{ event: 'maintenance_failed', reason: 'operation_unavailable', alert: true }]);
  assert.equal(db.queries.length, 1);
  assert.throws(() => assertMaintenanceIdentity(reply(goodIdentity), DATA + '-wrong'));
});

test('D15C-5C SQL exception is sanitized and unlocks', async () => {
  const db = mock({ errorOn: 'FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()' });
  const events = [];
  assert.deepEqual(await runControlledMaintenance(db, DATA, e => events.push(e)), { status: 'failed' });
  assert.equal(db.queries.at(-1).sql.includes('pg_advisory_unlock'), true);
  assert.equal(JSON.stringify(events).includes('password'), false);
  assert.equal(JSON.stringify(events).includes('postgres://'), false);
  assert.equal(events.at(-1).alert, true);
});

test('D15C-5C malformed or overlimit SQL results fail closed', async () => {
  for (const invalid of [
    { network_removed: 251, agent_removed: 0 },
    { network_removed: -1, agent_removed: 0 },
    { network_removed: '1', agent_removed: 1 },
    { network_removed: 1, agent_removed: 1, injected: 'ok' },
  ]) {
    const db = mock({ batches: [invalid] }); const events = [];
    assert.deepEqual(await runControlledMaintenance(db, DATA, e => events.push(e)), { status: 'failed' });
    assert.equal(events.at(-1).event, 'maintenance_failed');
  }
});

test('D15C-5C unlock failure forbids a false success marker', async () => {
  const events = [];
  const result = await runControlledMaintenance(mock({ unlock: false }), DATA, e => events.push(e));
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(events.some(e => e.event === 'maintenance_completed'), false);
});

test('D15C-5C PostgreSQL error text is never exposed in event output', async () => {
  for (const fault of ['AS tcp_disabled', 'pg_try_advisory_lock', 'FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()']) {
    const events = [];
    await runControlledMaintenance(mock({ errorOn: fault }), DATA, e => events.push(e));
    assert.equal(JSON.stringify(events).includes('SECRET_DATABASE_URL'), false);
    assert.equal(events.at(-1).alert, true);
  }
});


test('D15C-5C restricted policy never reads protected physical data_directory', async () => {
  const db = mock();
  const events = [];
  assert.deepEqual(await runControlledMaintenance(db, DATA, e => events.push(e)), {
    status: 'completed', batches: 1, networkRemoved: 0,
    agentRemoved: 0, possibleBacklog: false,
  });
  const identitySql = db.queries[0].sql;
  assert.ok(identitySql.includes('current_database() AS db'));
  assert.ok(identitySql.includes('current_user AS role'));
  assert.equal(identitySql.includes("current_setting('data_directory')"), false);
  assert.equal(db.queries.some(q => q.sql.includes('pg_read_all_settings')), false);
});

test('D15C-5C rejects malformed test-only cluster path before lock', async () => {
  const db = mock();
  const events = [];
  const result = await runControlledMaintenance(db,
    '/tmp/not-a-verified-pulse-cluster/data', e => events.push(e));
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(db.queries.length, 1);
  assert.deepEqual(events, [{ event: 'maintenance_failed',
    reason: 'operation_unavailable', alert: true }]);
});


test('D15C-5C disposable diagnostics identify pre-lock failures without error strings', async () => {
  const events = []; const phases = [];
  const db = mock({ errorOn: 'AS tcp_disabled' });
  const result = await runControlledMaintenance(db, DATA, e => events.push(e),
    phase => phases.push(phase));
  assert.deepEqual(result, { status: 'failed' });
  assert.deepEqual(phases, ['identity_query']);
  assert.deepEqual(events, [{ event: 'maintenance_failed',
    reason: 'operation_unavailable', alert: true }]);
  assert.equal(JSON.stringify(phases).includes('postgres://'), false);
});

test('D15C-5C disposable diagnostics distinguish failed identity assertion from lock query', async () => {
  const failures = [
    { opts: { identity: { ...goodIdentity, role: 'pulse_metrics_app' } }, phase: 'identity_assertion' },
    { opts: { errorOn: 'pg_try_advisory_lock' }, phase: 'lock_query' },
  ];
  for (const item of failures) {
    const phases = [];
    const result = await runControlledMaintenance(mock(item.opts), DATA,
      () => {}, phase => phases.push(phase));
    assert.deepEqual(result, { status: 'failed' });
    assert.deepEqual(phases, [item.phase]);
  }
});

test('D15C-5C successful overlap produces no diagnostic and no maintenance writes', async () => {
  const phases = [];
  const db = mock({ lock: false });
  const result = await runControlledMaintenance(db, DATA, () => {},
    phase => phases.push(phase));
  assert.deepEqual(result, { status: 'overlap_skipped' });
  assert.deepEqual(phases, []);
  assert.equal(db.queries.some(q => q.sql.includes('prune_expired_quota_buckets()') &&
    q.sql.includes('FROM pulse_telemetry_maintenance')), false);
});


test('D15C-5C restricted identity SQL does not resolve private ACL objects', async () => {
  const db = mock({ lock: false });
  const result = await runControlledMaintenance(db, DATA);
  assert.deepEqual(result, { status: 'overlap_skipped' });
  const sql = db.queries[0].sql;
  for (const forbidden of [
    'has_table_privilege', 'has_function_privilege', 'pg_has_role',
    'to_regclass', 'to_regprocedure', 'pg_class', 'pg_proc',
    'pulse_telemetry_quota', 'pulse_telemetry_agent_quota',
    'pulse_telemetry_maintenance', 'data_directory',
  ]) {
    assert.equal(sql.includes(forbidden), false,
      `restricted session check must not resolve ${forbidden}`);
  }
});

test('D15C-5C lost maintenance EXECUTE permission fails closed after lock', async () => {
  const db = mock({ errorOn: 'FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()' });
  const events = []; const phases = [];
  const result = await runControlledMaintenance(db, DATA,
    e => events.push(e), phase => phases.push(phase));
  assert.deepEqual(result, { status: 'failed' });
  assert.deepEqual(phases, ['prune_query']);
  assert.equal(db.queries.filter(q => q.sql.includes('pg_advisory_unlock')).length, 1);
  // The controller emits an explicit start before the function call.
  // A subsequent PostgreSQL permission failure must produce one final
  // sanitized failure event, with no success or SQL-driver details.
  assert.deepEqual(events, [
    { event: 'maintenance_started', alert: false },
    { event: 'maintenance_failed', reason: 'operation_unavailable', alert: true },
  ]);
  assert.equal(JSON.stringify(events).includes('postgres://'), false);
  assert.equal(JSON.stringify(events).includes('password'), false);
});
