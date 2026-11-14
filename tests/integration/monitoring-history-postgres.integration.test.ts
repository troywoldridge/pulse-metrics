/**
 * D15C-5M: real 5L history service and Express route on disposable PostgreSQL.
 * The wrapper verifies the dedicated cluster before launching this process.
 * A synthetic WorkOS verifier is injected ONLY for local HTTP test traffic.
 * This does not test live WorkOS JWTs or authorize a production route mount.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { sql } from 'drizzle-orm';
import { closeDatabase, getDatabase } from '../../src/db/client.js';
import { monitoredAgents, telemetrySamples } from '../../src/db/schema.js';
import { requireWorkOSUser, type AuthenticatedIdentity, type TokenVerifier } from '../../src/server/auth/workos-auth.js';
import { parseHistoryRequest } from '../../src/server/monitoring/history-contract.js';
import { createHistoryRoute } from '../../src/server/monitoring/history-route.js';
import {
  HistoryAccessDeniedError,
  HistoryAgentNotFoundError,
  readHistoryForIdentity,
} from '../../src/server/monitoring/history-service.js';

const ORG_A = '00000000-0000-4000-8000-00000005a001';
const ORG_B = '00000000-0000-4000-8000-00000005b001';
const AGENT_A = '00000000-0000-4000-8000-00000005a201';
const AGENT_VOLUME = '00000000-0000-4000-8000-00000005a202';
const AGENT_EMPTY = '00000000-0000-4000-8000-00000005a203';
const AGENT_B = '00000000-0000-4000-8000-00000005b201';
const NONEXISTENT_AGENT = '00000000-0000-4000-8000-00000005a299';
const IDENTITY_A: AuthenticatedIdentity = {
  provider: 'workos', subject: 'user_5m_alpha', sessionId: 'fixture-session-a',
};
const IDENTITY_B: AuthenticatedIdentity = {
  provider: 'workos', subject: 'user_5m_beta', sessionId: 'fixture-session-b',
};

function assertIsolatedTarget(): void {
  const socket = process.env.PULSE_5M_SOCKET;
  const data = process.env.PULSE_5M_DATA;
  const phase = process.env.PULSE_5M_PHASE;
  if (process.env.NODE_ENV === 'production' ||
      !socket || !/^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/.test(socket) ||
      data !== socket.replace(/\/socket$/, '/data') ||
      (phase !== 'initial' && phase !== 'revoked') ||
      process.env.DATABASE_POOL_MAX !== '1') {
    throw new Error('REFUSE_D15C5M_ENVIRONMENT');
  }
  const url = new URL(process.env.DATABASE_URL ?? '');
  if ((url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
      url.hostname !== 'localhost' || url.username !== 'pulse_metrics_app' ||
      url.pathname !== '/pulse_metrics' ||
      url.searchParams.get('host') !== socket ||
      url.searchParams.get('port') !== '55432') {
    throw new Error('REFUSE_D15C5M_DATABASE_DESTINATION');
  }
}

async function assertRuntime() {
  const database = getDatabase();
  const result = await database.execute(sql`
    SELECT current_user AS db_role, current_database() AS db_name,
           inet_server_addr() IS NULL AS socket_only,
           current_setting('port') AS port,
           pg_backend_pid() AS pid
  `);
  const row = result.rows[0];
  assert.equal(row?.db_role, 'pulse_metrics_app');
  assert.equal(row?.db_name, 'pulse_metrics');
  assert.equal(row?.socket_only, true);
  assert.equal(row?.port, '55432');
  assert.ok(typeof row?.pid === 'number' && Number.isSafeInteger(row.pid));
  return row?.pid;
}

const verifier: TokenVerifier = async token => {
  const identity = token === 'fixture.a.token' ? IDENTITY_A
    : token === 'fixture.b.token' ? IDENTITY_B : null;
  return identity ? {
    sub: identity.subject, sid: identity.sessionId,
    iss: 'https://example.invalid', exp: 4102444800,
  } : null;
};

async function httpHarness() {
  const app = express();
  app.disable('x-powered-by');
  app.use('/test', requireWorkOSUser(verifier));
  app.get('/test/organizations/:organizationId/agents/:agentId/history', createHistoryRoute());
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const get = (organizationId: string, agentId: string, token: string | null = 'fixture.a.token', suffix = '?range=1h') => {
    const headers: Record<string, string> = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return fetch(`${base}/test/organizations/${organizationId}/agents/${agentId}/history${suffix}`, { headers });
  };
  return { server, get };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

// Exactly one sequential integration case prevents membership changes and
// database pool reuse checks from racing one another.
test('D15C-5M real PostgreSQL tenant-history integration', async () => {
  assertIsolatedTarget();
  let server: Server | undefined;
  try {
    const phase = process.env.PULSE_5M_PHASE;
    const database = getDatabase();
    const originalPid = await assertRuntime();

    // These grants are not the sole authorization boundary; RLS + the 5L
    // service membership check must both apply to user-selected history.
    const grants = await database.execute(sql`
      SELECT rolsuper, rolbypassrls, rolcreatedb,
        has_table_privilege(current_user, 'public.agent_credentials', 'SELECT') AS credential_select,
        has_table_privilege(current_user, 'public.agent_enrollment_tokens', 'SELECT') AS enrollment_select,
        has_table_privilege(current_user, 'public.telemetry_samples', 'UPDATE') AS sample_update,
        has_table_privilege(current_user, 'public.telemetry_samples', 'DELETE') AS sample_delete
      FROM pg_roles WHERE rolname = current_user
    `);
    assert.equal(grants.rows[0]?.rolsuper, false);
    assert.equal(grants.rows[0]?.rolbypassrls, false);
    assert.equal(grants.rows[0]?.rolcreatedb, false);
    for (const key of ['credential_select', 'enrollment_select', 'sample_update', 'sample_delete']) {
      assert.equal(grants.rows[0]?.[key], false, `${key} must be denied`);
    }

    // Without a verified transaction-local tenant context, direct ORM reads
    // must not accidentally inherit the previous HTTP request's tenant.
    assert.equal((await database.select().from(monitoredAgents)).length, 0);
    assert.equal((await database.select().from(telemetrySamples)).length, 0);

    const reqA = parseHistoryRequest(ORG_A, AGENT_A, { range: '1h' });
    const reqB = parseHistoryRequest(ORG_B, AGENT_B, { range: '1h' });

    if (phase === 'initial') {
      const historyA = await readHistoryForIdentity(IDENTITY_A, reqA);
      assert.equal(historyA.organizationId, ORG_A);
      assert.equal(historyA.agentId, AGENT_A);
      assert.equal(historyA.truncated, false);
      assert.equal(historyA.points.length, 3);
      assert.deepEqual(historyA.points.map(p => p.cpuUsagePercent), [21.5, null, 61.25]);
      assert.deepEqual(historyA.points.map(p => p.memoryUsagePercent), [50, null, 62]);
      assert.deepEqual(historyA.points.map(p => p.diskUsagePercent), [75, null, 67]);
      assert.ok(historyA.points.every(p => p.networkReceiveBytesPerSecond === null && p.networkTransmitBytesPerSecond === null));
      assert.ok(historyA.points.every(p => !Object.hasOwn(p, 'metrics')));
      assert.ok(historyA.points.every((p, index) => index === 0 || p.recordedAt >= historyA.points[index - 1].recordedAt));

      const historyB = await readHistoryForIdentity(IDENTITY_B, reqB);
      assert.deepEqual(historyB.points.map(p => p.cpuUsagePercent), [98]);
      await assert.rejects(() => readHistoryForIdentity(IDENTITY_A, reqB), HistoryAccessDeniedError);
      await assert.rejects(() => readHistoryForIdentity(IDENTITY_B, reqA), HistoryAccessDeniedError);

      await assert.rejects(
        () => readHistoryForIdentity(IDENTITY_A, parseHistoryRequest(ORG_A, AGENT_B, {})),
        HistoryAgentNotFoundError,
      );
      await assert.rejects(
        () => readHistoryForIdentity(IDENTITY_A, parseHistoryRequest(ORG_A, NONEXISTENT_AGENT, {})),
        HistoryAgentNotFoundError,
      );
      const empty = await readHistoryForIdentity(IDENTITY_A, parseHistoryRequest(ORG_A, AGENT_EMPTY, {}));
      assert.equal(empty.points.length, 0);
      assert.equal(empty.truncated, false);

      const volume = await readHistoryForIdentity(IDENTITY_A, parseHistoryRequest(ORG_A, AGENT_VOLUME, { range: '15m' }));
      assert.equal(volume.points.length, 500);
      assert.equal(volume.truncated, true);
      assert.equal(volume.points[0].cpuUsagePercent, 2.5);
      assert.equal(volume.points[499].cpuUsagePercent, 1.5);
      assert.ok(volume.points.every((p, i) => i === 0 || p.recordedAt >= volume.points[i - 1].recordedAt));

      const harness = await httpHarness();
      server = harness.server;
      const good = await harness.get(ORG_A, AGENT_A);
      assert.equal(good.status, 200);
      assert.equal(good.headers.get('cache-control'), 'no-store');
      const goodBody = await good.json() as { points: Array<Record<string, unknown>> };
      assert.deepEqual(goodBody.points.map(p => p.cpuUsagePercent), [21.5, null, 61.25]);
      assert.ok(goodBody.points.every(p => !Object.hasOwn(p, 'metrics')));
      assert.equal((await harness.get(ORG_B, AGENT_B)).status, 403);
      assert.equal((await harness.get(ORG_A, AGENT_B)).status, 404);
      assert.equal((await harness.get(ORG_A, NONEXISTENT_AGENT)).status, 404);
      assert.equal((await harness.get(ORG_B, AGENT_B, 'fixture.b.token')).status, 200);
      assert.equal((await harness.get(ORG_A, AGENT_A, null)).status, 401);
      assert.equal((await harness.get(ORG_A, AGENT_A, 'bad.fixture.token')).status, 401);
      assert.equal((await harness.get(ORG_A, AGENT_A, 'fixture.a.token', '?range=1h&userId=admin')).status, 400);
    } else {
      // A's membership was deleted by the administrator BETWEEN test phases.
      await assert.rejects(() => readHistoryForIdentity(IDENTITY_A, reqA), HistoryAccessDeniedError);
      const surviving = await readHistoryForIdentity(IDENTITY_B, reqB);
      assert.deepEqual(surviving.points.map(p => p.cpuUsagePercent), [98]);
      const harness = await httpHarness();
      server = harness.server;
      assert.equal((await harness.get(ORG_A, AGENT_A)).status, 403);
      assert.equal((await harness.get(ORG_B, AGENT_B, 'fixture.b.token')).status, 200);
    }

    const after = await database.execute(sql`
      SELECT pg_backend_pid() AS pid,
        NULLIF(current_setting('app.current_organization_id', true), '') AS organization_id,
        NULLIF(current_setting('app.current_user_id', true), '') AS user_id
    `);
    assert.equal(after.rows[0]?.pid, originalPid, 'single-connection backend must be reused');
    assert.equal(after.rows[0]?.organization_id, null);
    assert.equal(after.rows[0]?.user_id, null);
    assert.equal((await database.select().from(telemetrySamples)).length, 0);
    console.log(`PASS: real restricted app-role history, tenant RLS and pool isolation (${phase})`);
  } finally {
    if (server) await closeServer(server);
    await closeDatabase();
  }
});
