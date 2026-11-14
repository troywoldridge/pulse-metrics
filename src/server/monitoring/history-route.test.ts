import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from '../auth/workos-auth.js';
import {
  createHistoryRoute, type HistoryLoader,
} from './history-route.js';
import { presentHistory } from './history-contract.js';
import { HistoryAccessDeniedError, HistoryAgentNotFoundError } from './history-service.js';

const ORG_A = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const ORG_B = '3a1b0033-0fd2-4a45-b711-32ef63ce0178';
const AGENT = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
let calls = 0;
let outcome: 'ok' | 'deny' | 'not-found' | 'outage' | 'mismatch' | 'malformed' = 'ok';

const verifier: TokenVerifier = async token => token === 'good.test.token'
  ? { sub: 'user_verified_caller', sid: 'session_verified_caller',
      iss: 'https://example.invalid', exp: 4_102_444_800 }
  : null;
const loader: HistoryLoader = async (identity, request) => {
  calls++;
  assert.equal(identity.provider, 'workos');
  assert.equal(identity.subject, 'user_verified_caller');
  if (outcome === 'deny') throw new HistoryAccessDeniedError();
  if (outcome === 'not-found') throw new HistoryAgentNotFoundError();
  if (outcome === 'outage') throw new Error('PRIVATE_DATABASE_SECRETS');
  const response = presentHistory(request, [{
    recordedAt: new Date(request.until.getTime() - 5_000),
    receivedAt: new Date(request.until.getTime() - 4_750),
    cpuUsagePercent: 32, memoryUsagePercent: null,
    diskUsagePercent: 12, networkReceiveBytesPerSecond: null,
    networkTransmitBytesPerSecond: null,
  }]);
  if (outcome === 'mismatch') return { ...response, organizationId: ORG_B };
  if (outcome === 'malformed') return {
    ...response, points: [{ ...response.points[0], networkReceiveBytesPerSecond: 99.99 }],
  };
  return response;
};
let protectedServer: Server;
let bareServer: Server;
let base = '';
let bare = '';

async function listen(app: ReturnType<typeof express>): Promise<[Server, string]> {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  return [server, `http://127.0.0.1:${address.port}`];
}

before(async () => {
  const app = express();
  app.use('/api', requireWorkOSUser(verifier));
  app.get('/api/organizations/:organizationId/agents/:agentId/history', createHistoryRoute(loader));
  [protectedServer, base] = await listen(app);
  const noAuth = express();
  noAuth.get('/api/organizations/:organizationId/agents/:agentId/history', createHistoryRoute(loader));
  [bareServer, bare] = await listen(noAuth);
});

after(async () => {
  for (const server of [protectedServer, bareServer]) {
    if (server?.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});

function url(organizationId = ORG_A, agentId = AGENT, suffix = '') {
  return `/api/organizations/${organizationId}/agents/${agentId}/history${suffix}`;
}
async function get(path = url(), token: string | null = 'good.test.token') {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(base + path, { headers });
}

test('5L missing bearer denied before history loader', async () => {
  const start = calls;
  assert.equal((await get(url(), null)).status, 401);
  assert.equal(calls, start);
});

test('5L invalid bearer denied before history loader', async () => {
  const start = calls;
  assert.equal((await get(url(), 'bad.test.token')).status, 401);
  assert.equal(calls, start);
});

test('5L handler without verified authentication middleware refuses reads', async () => {
  const start = calls;
  assert.equal((await fetch(bare + url())).status, 401);
  assert.equal(calls, start);
});

test('5L malformed organization and agent identifiers never reach reader', async () => {
  const start = calls;
  assert.equal((await get(url('invalid'))).status, 400);
  assert.equal((await get(url(ORG_A, 'invalid'))).status, 400);
  assert.equal(calls, start);
});

test('5L query cannot override user, tenant, role or arbitrary timestamps', async () => {
  const start = calls;
  for (const suffix of ['?userId=forged', '?role=owner', '?organizationId=forged',
    '?range=30d', '?range=1h&range=7d', '?since=1', '?limit=100000']) {
    assert.equal((await get(url(ORG_A, AGENT, suffix))).status, 400);
  }
  assert.equal(calls, start);
});

test('5L valid WorkOS bearer yields only filtered genuine historical fields', async () => {
  const response = await get(url(ORG_A, AGENT, '?range=15m'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.organizationId, ORG_A);
  assert.equal(body.agentId, AGENT);
  assert.equal(body.range, '15m');
  assert.equal(body.truncated, false);
  const points = body.points as Record<string, unknown>[];
  assert.equal(points[0].cpuUsagePercent, 32);
  assert.equal(points[0].networkReceiveBytesPerSecond, null);
  assert.equal('metrics' in points[0], false);
});

test('5L denies unauthorized tenant without revealing data', async () => {
  outcome = 'deny';
  try {
    const response = await get(url(ORG_B));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'organization_access_denied' });
  } finally { outcome = 'ok'; }
});

test('5L agent not found is indistinguishable from unauthorized foreign agent', async () => {
  outcome = 'not-found';
  try {
    const response = await get();
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'agent_not_found' });
  } finally { outcome = 'ok'; }
});

test('5L database outages return sanitized 503', async () => {
  outcome = 'outage';
  try {
    const response = await get();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    const text = await response.text();
    assert.doesNotMatch(text, /PRIVATE_DATABASE_SECRETS/);
  } finally { outcome = 'ok'; }
});

test('5L mismatched tenant response fails closed', async () => {
  outcome = 'mismatch';
  try { assert.equal((await get()).status, 503); }
  finally { outcome = 'ok'; }
});

test('5L malformed numeric result fails closed rather than fabricating a value', async () => {
  outcome = 'malformed';
  try { assert.equal((await get()).status, 503); }
  finally { outcome = 'ok'; }
});
