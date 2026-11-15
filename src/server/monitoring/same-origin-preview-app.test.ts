import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import type { TokenVerifier } from '../auth/workos-auth.js';
import { presentHistory } from './history-contract.js';
import { createSameOriginHistoryPreviewApp } from './same-origin-preview-app.js';

const ORG_A = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const ORG_B = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
const AGENT_A = '3a1b0033-0fd2-4a45-b711-32ef63ce0178';
let server: Server;
let base = '';
let organizationsCalled = 0;
let historyCalled = 0;
const verify: TokenVerifier = async token => token === 'verified.test.token'
  ? { sub: 'user_5p_fixture', sid: 'session_fixture',
      iss: 'https://example.invalid', exp: 4_102_444_800 }
  : null;

before(async () => {
  const app = createSameOriginHistoryPreviewApp(verify, {
    listOrganizations: async identity => {
      organizationsCalled++;
      assert.equal(identity.subject, 'user_5p_fixture');
      return [{ id: ORG_A, name: 'Authorized fixture', slug: 'authorized-fixture', role: 'viewer' }];
    },
    loadHistory: async (identity, request) => {
      historyCalled++;
      assert.equal(identity.subject, 'user_5p_fixture');
      assert.equal(request.organizationId, ORG_A);
      assert.equal(request.agentId, AGENT_A);
      return presentHistory(request, [{
        recordedAt: new Date(request.until.getTime() - 10_000),
        receivedAt: new Date(request.until.getTime() - 9_000),
        cpuUsagePercent: 0,
        memoryUsagePercent: null,
        diskUsagePercent: 24,
        networkReceiveBytesPerSecond: null,
        networkTransmitBytesPerSecond: null,
      }]);
    },
  });
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

async function get(path: string, token: string | null = 'verified.test.token') {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(base + path, { headers, redirect: 'error' });
}

const historyPath = `/api/organizations/${ORG_A}/agents/${AGENT_A}/history?range=1h`;

test('5P rejects a missing verifier dependency', () => {
  assert.throws(() => createSameOriginHistoryPreviewApp(undefined as unknown as TokenVerifier), TypeError);
});

test('5P both organization discovery and history require a bearer first', async () => {
  const a = organizationsCalled;
  const h = historyCalled;
  for (const path of ['/api/organizations', historyPath]) {
    assert.equal((await get(path, null)).status, 401);
    assert.equal((await get(path, 'invalid')).status, 401);
  }
  assert.equal(organizationsCalled, a);
  assert.equal(historyCalled, h);
});

test('5P authenticated organization listing is sanitized and no-store', async () => {
  const response = await get('/api/organizations');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), {
    organizations: [{ id: ORG_A, name: 'Authorized fixture', slug: 'authorized-fixture', role: 'viewer' }],
  });
});

test('5P authenticated history preserves measured zero, null, and tenant selectors', async () => {
  const response = await get(historyPath);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.organizationId, ORG_A);
  assert.equal(result.agentId, AGENT_A);
  assert.equal(result.range, '1h');
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].cpuUsagePercent, 0);
  assert.equal(result.points[0].memoryUsagePercent, null);
});

test('5P forged selectors cannot reach the history adapter', async () => {
  const count = historyCalled;
  for (const path of [
    `${historyPath}&userId=forged`, `${historyPath}&organizationId=${ORG_B}`,
    `${historyPath}&role=owner`, `${historyPath}&since=2026-01-01`,
  ]) {
    assert.equal((await get(path)).status, 400);
  }
  assert.equal(historyCalled, count);
});

test('5P all non-read monitoring APIs stay unavailable', async () => {
  const a = organizationsCalled;
  const h = historyCalled;
  for (const path of ['/api/hosts', '/api/telemetry', '/api/history', '/api/agents',
    `/api/organizations/${ORG_A}/agents`]) {
    const response = await get(path);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'organization_authorization_pending' });
  }
  const response = await fetch(base + historyPath, {
    method: 'POST', headers: { Authorization: 'Bearer verified.test.token' },
  });
  assert.equal(response.status, 503);
  assert.equal(organizationsCalled, a);
  assert.equal(historyCalled, h);
});

test('5P unauthenticated unrecognized API never gains an authorization hint', async () => {
  assert.equal((await get('/api/hosts', null)).status, 401);
});
