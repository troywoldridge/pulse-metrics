import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import type { TokenVerifier } from '../auth/workos-auth.js';
import { presentHistory } from './history-contract.js';
import { AgentListAccessDeniedError } from './agent-list-service.js';
import { createAgentPickerHistoryPreviewApp } from './agent-picker-preview-app.js';

const ORG = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const FOREIGN = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
const AGENT = '3a1b0033-0fd2-4a45-b711-32ef63ce0178';
const list = { organizationId: ORG, agents: [{
  id: AGENT, displayName: 'Authorized server', hostname: 'local-node',
  platform: 'linux', status: 'pending' as const, lastSeenAt: null,
}] };
const verify: TokenVerifier = async token => token === 'verified.fixture'
  ? { sub: 'user_fixture_5q', sid: 'session_5q', iss: 'https://example.invalid', exp: 4102444800 }
  : null;
let server: Server;
let base = '';
let agentCalls = 0;
let historyCalls = 0;

before(async () => {
  const app = createAgentPickerHistoryPreviewApp(verify, {
    listOrganizations: async identity => {
      assert.equal(identity.subject, 'user_fixture_5q');
      return [{ id: ORG, name: 'Development', slug: 'development', role: 'owner' }];
    },
    listAgents: async (identity, organizationId) => {
      agentCalls++;
      assert.equal(identity.subject, 'user_fixture_5q');
      if (organizationId !== ORG) throw new AgentListAccessDeniedError();
      return list;
    },
    loadHistory: async (_identity, request) => {
      historyCalls++;
      if (request.organizationId !== ORG || request.agentId !== AGENT) {
        throw new Error('unauthorized test selector');
      }
      return presentHistory(request, []);
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

async function get(path: string, bearer: string | null = 'verified.fixture') {
  return fetch(base + path, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    redirect: 'error' });
}

test('5Q refuses absent verifier dependency', () => {
  assert.throws(() => createAgentPickerHistoryPreviewApp(null as unknown as TokenVerifier), TypeError);
});

test('5Q agent-list API requires WorkOS bearer before loader', async () => {
  const beforeCalls = agentCalls;
  const path = `/api/organizations/${ORG}/agents`;
  assert.equal((await get(path, null)).status, 401);
  assert.equal((await get(path, 'bad')).status, 401);
  assert.equal(agentCalls, beforeCalls);
});

test('5Q authorized organization lists only sanitized agent fields', async () => {
  const res = await get(`/api/organizations/${ORG}/agents`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await res.json(), list);
});

test('5Q invalid selector and forged query cannot reach adapter', async () => {
  const previous = agentCalls;
  for (const path of [
    '/api/organizations/not-a-uuid/agents',
    `/api/organizations/${ORG}/agents?role=owner`,
    `/api/organizations/${ORG}/agents?userId=forged`,
  ]) assert.equal((await get(path)).status, 400);
  assert.equal(agentCalls, previous);
});

test('5Q foreign organization is denied without disclosing agent IDs', async () => {
  const response = await get(`/api/organizations/${FOREIGN}/agents`);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'organization_access_denied' });
});

test('5Q existing genuine history route remains available only read-only', async () => {
  const response = await get(`/api/organizations/${ORG}/agents/${AGENT}/history?range=1h`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).points.length, 0);
  assert.equal(historyCalls > 0, true);
});

test('5Q all writes and unrelated monitoring APIs fail closed', async () => {
  for (const path of ['/api/hosts', '/api/telemetry', '/api/history', '/api/agents']) {
    const res = await get(path);
    assert.equal(res.status, 503);
  }
  const post = await fetch(base + `/api/organizations/${ORG}/agents`, {
    method: 'POST', headers: { Authorization: 'Bearer verified.fixture' },
  });
  assert.equal(post.status, 503);
});
