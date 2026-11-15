import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPreviewAgents } from './preview-agent-client.js';

const ORG = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const FOREIGN = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
const AGENT = '3a1b0033-0fd2-4a45-b711-32ef63ce0178';
const orgs = [{ id: ORG, name: 'Development', slug: 'development', role: 'owner' as const }];
const payload = { organizationId: ORG, agents: [{ id: AGENT, displayName: 'Local server',
  hostname: 'node', platform: 'linux', status: 'pending', lastSeenAt: null }] };
const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

test('5Q sends verified bearer only to fixed same-origin tenant path', async () => {
  let count = 0;
  const result = await readPreviewAgents({ organizationId: ORG, authorizedOrganizations: orgs,
    getAccessToken: async () => 'good.token',
    fetcher: async (path, options) => {
      count++;
      assert.equal(path, `/api/organizations/${ORG}/agents`);
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer good.token');
      return json(payload);
    },
  });
  assert.equal(count, 1);
  assert.deepEqual(result, { ok: true, data: payload });
});

test('5Q foreign organization or invalid token never touches agent API', async () => {
  let count = 0;
  const fetcher = async () => { count++; return json(payload); };
  for (const [orgId, token] of [[FOREIGN, 'valid.token'], [ORG, 'bad\r\nheader']] as const) {
    const result = await readPreviewAgents({ organizationId: orgId,
      authorizedOrganizations: orgs, getAccessToken: async () => token, fetcher });
    assert.equal(result.ok, false);
  }
  const controller = new AbortController(); controller.abort();
  const result = await readPreviewAgents({ organizationId: ORG, authorizedOrganizations: orgs,
    getAccessToken: async () => 'valid.token', fetcher, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(count, 0);
});

test('5Q rejects wrong tenant and unauthorized response shapes', async () => {
  for (const bad of [{ ...payload, organizationId: FOREIGN },
    { ...payload, agents: [{ ...payload.agents[0], credential: 'secret' }] },
    { ...payload, agents: [{ ...payload.agents[0], status: 'revoked' }] }]) {
    assert.deepEqual(await readPreviewAgents({ organizationId: ORG, authorizedOrganizations: orgs,
      getAccessToken: async () => 'token', fetcher: async () => json(bad),
    }), { ok: false, reason: 'invalid_response' });
  }
});

test('5Q handles denied, unavailable, non-JSON and oversized safely', async () => {
  for (const [response, reason] of [
    [new Response('', { status: 401 }), 'authentication_required'],
    [new Response('', { status: 403 }), 'access_denied'],
    [new Response('', { status: 503 }), 'unavailable'],
    [new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'text/html' } }), 'unavailable'],
    [new Response('x'.repeat(40001), { status: 200, headers: { 'Content-Type': 'application/json' } }), 'unavailable'],
  ] as const) {
    const result = await readPreviewAgents({ organizationId: ORG, authorizedOrganizations: orgs,
      getAccessToken: async () => 'valid.token', fetcher: async () => response });
    assert.deepEqual(result, { ok: false, reason });
  }
});

test('5Q sanitizes provider and network failures', async () => {
  const a = await readPreviewAgents({ organizationId: ORG, authorizedOrganizations: orgs,
    getAccessToken: async () => { throw new Error('PRIVATE_WORKOS_SECRET'); } });
  const b = await readPreviewAgents({ organizationId: ORG, authorizedOrganizations: orgs,
    getAccessToken: async () => 'token', fetcher: async () => { throw new Error('PRIVATE_SQL_SECRET'); } });
  assert.deepEqual([a, b], [{ ok: false, reason: 'unavailable' }, { ok: false, reason: 'unavailable' }]);
  assert.doesNotMatch(JSON.stringify([a, b]), /PRIVATE_/);
});
