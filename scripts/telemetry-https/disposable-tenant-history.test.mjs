/** Offline refusal/order tests for D15C-5U-2F2A disposable SQL history probe. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDisposableTenantHistory } from './disposable-tenant-history.mjs';

const U1 = '00000000-0000-4000-8000-000000000001';
const A1 = '00000000-0000-4000-8000-000000000002';
const H1 = '00000000-0000-4000-8000-000000000003';
const U2 = '00000000-0000-4000-8000-000000000004';
const A2 = '00000000-0000-4000-8000-000000000005';
const H2 = '00000000-0000-4000-8000-000000000006';
const GENUINE = {
  recorded_at: new Date('2026-11-15T17:00:00.000Z'),
  received_at: new Date('2026-11-15T17:00:01.000Z'),
  cpu_usage_percent: 4.1,
  memory_usage_percent: 32.2,
  disk_usage_percent: null,
  network_receive_bytes_per_second: null,
  network_transmit_bytes_per_second: null,
};

function fakePool({ deny = false, wrongDb = false, leak = false,
                    noAgent = false, failRead = false } = {}) {
  const queries = [];
  const releases = [];
  let inTransaction = false;
  let user = '';
  let organization = '';
  let countCalls = 0;
  const client = {
    async query(q, v = []) {
      const s = q.trim();
      queries.push([s, v]);
      if (s.startsWith('SELECT current_database()')) {
        return { rows: [{ db: 'pulse_metrics', role: wrongDb ? 'postgres' : 'pulse_metrics_app', port: '55432', unix_only: true }] };
      }
      if (s.includes('count(*)::integer AS n FROM public.telemetry_samples')) {
        countCalls += 1;
        return { rows: [{ n: leak && countCalls === 1 ? 1 : 0 }] };
      }
      if (s === 'BEGIN READ ONLY') {
        assert.equal(inTransaction, false);
        inTransaction = true;
        return { rows: [] };
      }
      if (s === 'ROLLBACK') {
        assert.equal(inTransaction, true);
        inTransaction = false;
        user = '';
        organization = '';
        return { rows: [] };
      }
      if (s.includes("set_config('app.current_organization_id', '', true)")) {
        assert.equal(inTransaction, true);
        user = v[0];
        organization = '';
        return { rows: [] };
      }
      if (s.includes('FROM public.organization_memberships')) {
        assert.equal(organization, '');
        assert.deepEqual(v, [deny ? A2 : A1, U1]);
        return { rows: deny ? [] : [{ user_id: U1 }] };
      }
      if (s.includes("set_config('app.current_organization_id', $1::text, true)")) {
        assert.equal(user, U1);
        organization = v[0];
        return { rows: [] };
      }
      if (s.includes('FROM public.monitored_agents')) {
        assert.equal(organization, A1);
        return { rows: noAgent ? [] : [{ id: H1 }] };
      }
      if (s.includes('FROM public.telemetry_samples') && !s.includes('count(')) {
        assert.equal(inTransaction, true);
        assert.equal(organization, A1);
        if (failRead) throw new Error('simulated database failure');
        assert.deepEqual(v, [A1, H1]);
        return { rows: [GENUINE] };
      }
      throw new Error('Unexpected SQL statement');
    },
    release(err) { releases.push(err); },
  };
  return { pool: { async connect() { return client; } }, queries, releases };
}

test('5U-2F2A refuses invalid identities before opening SQL connection', async () => {
  const pool = { connect() { throw new Error('must not connect'); } };
  await assert.rejects(readDisposableTenantHistory(pool, {
    userId: 'not-a-uuid', organizationId: A1, agentId: H1,
  }), TypeError);
  await assert.rejects(readDisposableTenantHistory(pool, {
    userId: U1, organizationId: A1, agentId: 'x',
  }), TypeError);
});

test('5U-2F2A rejects privileged or wrong database target and discards session', async () => {
  const f = fakePool({ wrongDb: true });
  await assert.rejects(readDisposableTenantHistory(f.pool, {
    userId: U1, organizationId: A1, agentId: H1,
  }), /Disposable restricted SQL connection required/);
  assert.equal(f.releases.length, 1);
  assert.ok(f.releases[0] instanceof Error);
  assert.equal(f.queries.some(([q]) => q === 'BEGIN READ ONLY'), false);
});

test('5U-2F2A reads only after READ ONLY transaction and verified membership', async () => {
  const f = fakePool();
  const result = await readDisposableTenantHistory(f.pool, {
    userId: U1, organizationId: A1, agentId: H1,
  });
  assert.deepEqual(result, { authorized: true, agentFound: true, samples: [GENUINE] });
  assert.deepEqual(f.releases, [undefined]);
  const q = f.queries.map(([s]) => s);
  const memberAt = q.findIndex(s => s.includes('FROM public.organization_memberships'));
  const orgAt = q.findIndex(s => s.includes("set_config('app.current_organization_id', $1::text, true)"));
  const agentAt = q.findIndex(s => s.includes('FROM public.monitored_agents'));
  const historyAt = q.findIndex(s => s.includes('FROM public.telemetry_samples') && !s.includes('count('));
  assert.ok(q.indexOf('BEGIN READ ONLY') < memberAt && memberAt < orgAt && orgAt < agentAt && agentAt < historyAt);
  assert.equal(q.at(-2), 'ROLLBACK');
  assert.ok(q.at(-1).includes('count(*)::integer AS n FROM public.telemetry_samples'));
});

test('5U-2F2A foreign tenant refuses before assigning organization or reading history', async () => {
  const f = fakePool({ deny: true });
  const result = await readDisposableTenantHistory(f.pool, {
    userId: U1, organizationId: A2, agentId: H2,
  });
  assert.deepEqual(result, { authorized: false, agentFound: false, samples: [] });
  assert.equal(f.queries.some(([q]) => q.includes("set_config('app.current_organization_id', $1::text, true)")), false);
  assert.equal(f.queries.some(([q]) => q.includes('FROM public.monitored_agents')), false);
  assert.deepEqual(f.releases, [undefined]);
});

test('5U-2F2A membership alone cannot read another agent', async () => {
  const f = fakePool({ noAgent: true });
  const result = await readDisposableTenantHistory(f.pool, {
    userId: U1, organizationId: A1, agentId: H1,
  });
  assert.deepEqual(result, { authorized: true, agentFound: false, samples: [] });
  assert.equal(f.queries.some(([q]) => q.includes('ORDER BY recorded_at DESC')), false);
});

test('5U-2F2A query failure rolls back before returning pool connection', async () => {
  const f = fakePool({ failRead: true });
  await assert.rejects(readDisposableTenantHistory(f.pool, {
    userId: U1, organizationId: A1, agentId: H1,
  }), /simulated database failure/);
  assert.equal(f.releases.length, 1);
  assert.ok(f.releases[0] instanceof Error);
  assert.equal(f.queries.at(-2)[0], 'ROLLBACK');
});

test('5U-2F2A refuses unscoped visibility and never returns contaminated pool session', async () => {
  const f = fakePool({ leak: true });
  await assert.rejects(readDisposableTenantHistory(f.pool, {
    userId: U1, organizationId: A1, agentId: H1,
  }), /Unscoped session could read samples/);
  assert.ok(f.releases[0] instanceof Error);
});
