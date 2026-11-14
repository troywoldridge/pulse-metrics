import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import type { TokenVerifier } from '../auth/workos-auth.js';
import { createLocalHistoryPreviewApp } from './history-preview-app.js';
import { presentHistory } from './history-contract.js';
import { HistoryAccessDeniedError, HistoryAgentNotFoundError } from './history-service.js';
import type { HistoryLoader } from './history-route.js';
import { rejectUnauthenticatedUpgrade } from '../legacy-transport.js';

const ORG = '00000000-0000-4000-8000-00000005a001';
const AGENT = '00000000-0000-4000-8000-00000005a201';
const FOREIGN_ORG = '00000000-0000-4000-8000-00000005b001';
const verifier: TokenVerifier = async token => token === 'fixture.local.token'
  ? { sub: 'user_5n_local', sid: 'session_5n_local',
      iss: 'https://example.invalid', exp: 4102444800 }
  : null;

async function withPreview(run: (base: string, getCount: () => number) => Promise<void>,
                           behavior: 'ok' | 'deny' | 'missing' | 'unavailable' = 'ok') {
  let calls = 0;
  const load: HistoryLoader = async (identity, request) => {
    calls++;
    assert.equal(identity.subject, 'user_5n_local');
    if (behavior === 'deny' || request.organizationId === FOREIGN_ORG) throw new HistoryAccessDeniedError();
    if (behavior === 'missing') throw new HistoryAgentNotFoundError();
    if (behavior === 'unavailable') throw new Error('PRIVATE_DATABASE_PASSWORD');
    return presentHistory(request, [{
      recordedAt: new Date(request.until.getTime() - 5000),
      receivedAt: new Date(request.until.getTime() - 4750),
      cpuUsagePercent: 35, memoryUsagePercent: null, diskUsagePercent: 80,
      networkReceiveBytesPerSecond: null, networkTransmitBytesPerSecond: null,
    }]);
  };
  const app = createLocalHistoryPreviewApp(verifier, load);
  const server: Server = createServer(app);
  server.on('upgrade', rejectUnauthenticatedUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`, () => calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
}

const path = `/api/organizations/${ORG}/agents/${AGENT}/history`;

function request(base: string, route: string, token: string | null = 'fixture.local.token') {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(base + route, { headers });
}

test('5N local composition rejects missing and invalid WorkOS bearer before loader', async () => {
  await withPreview(async (base, calls) => {
    assert.equal((await request(base, path, null)).status, 401);
    assert.equal((await request(base, path, 'bad.local.token')).status, 401);
    assert.equal(calls(), 0);
  });
});

test('5N valid test identity reaches only tenant history path with actual contract fields', async () => {
  await withPreview(async (base, calls) => {
    const response = await request(base, `${path}?range=15m`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = await response.json();
    assert.equal(body.organizationId, ORG);
    assert.equal(body.agentId, AGENT);
    assert.equal(body.range, '15m');
    assert.equal(body.points[0]?.cpuUsagePercent, 35);
    assert.equal(body.points[0]?.memoryUsagePercent, null);
    assert.equal(body.points[0]?.networkReceiveBytesPerSecond, null);
    assert.equal(calls(), 1);
  });
});

test('5N cannot select a browser user, role or arbitrary time range', async () => {
  await withPreview(async (base, calls) => {
    for (const query of ['?userId=forged', '?role=owner', '?range=1y', '?since=0', '?range=1h&range=7d']) {
      assert.equal((await request(base, path + query)).status, 400);
    }
    assert.equal(calls(), 0);
  });
});

test('5N foreign tenant denial, missing agent and backend outage are sanitized', async () => {
  await withPreview(async base => {
    const response = await request(base, `/api/organizations/${FOREIGN_ORG}/agents/${AGENT}/history`);
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /PRIVATE_DATABASE_PASSWORD/);
  });
  await withPreview(async base => {
    assert.equal((await request(base, path)).status, 404);
  }, 'missing');
  await withPreview(async base => {
    const response = await request(base, path);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /PRIVATE_DATABASE_PASSWORD/);
  }, 'unavailable');
});

test('5N all other monitoring API paths remain disabled', async () => {
  await withPreview(async (base, calls) => {
    for (const route of ['/api/history', '/api/hosts', '/api/metrics', '/api/telemetry']) {
      const response = await request(base, route);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(calls(), 0);
  });
});

test('5N preview never accepts a missing verifier or enables WebSockets', async () => {
  assert.throws(() => createLocalHistoryPreviewApp(undefined as unknown as TokenVerifier), TypeError);
  await withPreview(async base => {
    // The preview app has no authorized WebSocket endpoint; the CLI explicitly
    // installs the previously reviewed 403 upgrade handler.
    const response = await request(base, '/api/websocket');
    assert.equal(response.status, 503);
  });
});
