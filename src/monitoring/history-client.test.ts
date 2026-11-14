import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HISTORY_RESPONSE_MAX_BYTES, parseHistoryResponse, readTenantHistory,
  type HistoryFetcher,
} from './history-client.js';

const ORG_A = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const ORG_B = '3a1b0033-0fd2-4a45-b711-32ef63ce0178';
const AGENT = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
const NOW = Date.parse('2026-11-14T18:00:00.000Z');
const query = '2026-11-14T17:59:59.000Z';
const earlier = '2026-11-14T17:58:40.000Z';
const recent = '2026-11-14T17:59:45.000Z';

function point(recordedAt = recent) {
  return {
    recordedAt,
    receivedAt: recordedAt,
    cpuUsagePercent: 37.5,
    memoryUsagePercent: null,
    diskUsagePercent: 82,
    networkReceiveBytesPerSecond: null,
    networkTransmitBytesPerSecond: 0,
  };
}
function payload() {
  return { organizationId: ORG_A, agentId: AGENT, range: '1h',
    queriedAt: query, truncated: false, points: [point(earlier), point()] };
}
const expected = { organizationId: ORG_A, agentId: AGENT, range: '1h' } as const;
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

test('5O accepts only exact verified response with honest nullable metrics', () => {
  const result = parseHistoryResponse(payload(), expected, NOW);
  assert.ok(result);
  assert.equal(result.points[1].memoryUsagePercent, null);
  assert.equal(result.points[1].networkReceiveBytesPerSecond, null);
  assert.equal(result.points[1].networkTransmitBytesPerSecond, 0);
});

test('5O rejects forged organization, wrong agent and range', () => {
  for (const change of [
    { organizationId: ORG_B }, { agentId: ORG_B }, { range: '7d' },
    { role: 'owner' }, { userId: 'attacker' }, { metrics: { secret: true } },
  ]) assert.equal(parseHistoryResponse({ ...payload(), ...change }, expected, NOW), null);
});

test('5O rejects noncanonical timestamps, stale server response and future timestamps', () => {
  for (const change of [
    { queriedAt: '2026-11-14T17:59:59Z' },
    { queriedAt: '2026-11-14T17:50:00.000Z' },
    { queriedAt: '2026-11-14T18:10:00.000Z' },
    { points: [point('2026-11-14T19:00:00.000Z')] },
    { points: [point('2026-11-14T16:59:58.000Z')] },
  ]) assert.equal(parseHistoryResponse({ ...payload(), ...change }, expected, NOW), null);
});

test('5O rejects unsorted, extra keys, oversized and invalid numeric data', () => {
  assert.equal(parseHistoryResponse({ ...payload(), points: [point(), point(earlier)] }, expected, NOW), null);
  assert.equal(parseHistoryResponse({ ...payload(), points: [{ ...point(), hostname: 'private' }] }, expected, NOW), null);
  assert.equal(parseHistoryResponse({ ...payload(), points: [{ ...point(), cpuUsagePercent: -1 }] }, expected, NOW), null);
  assert.equal(parseHistoryResponse({ ...payload(), points: [{ ...point(), cpuUsagePercent: 101 }] }, expected, NOW), null);
  assert.equal(parseHistoryResponse({ ...payload(), points: [{ ...point(), networkTransmitBytesPerSecond: 3.14 }] }, expected, NOW), null);
  assert.equal(parseHistoryResponse({ ...payload(), points: Array.from({ length: 501 }, () => point()) }, expected, NOW), null);
  assert.equal(parseHistoryResponse(null, expected, NOW), null);
});

test('5O sends token only in Authorization header to same-origin fixed route', async () => {
  let called = 0;
  const fetcher: HistoryFetcher = async (url, init) => {
    called++;
    assert.equal(url, `/api/organizations/${ORG_A}/agents/${AGENT}/history?range=1h`);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer example.jwt.token');
    assert.doesNotMatch(url, /jwt|token|userId|role/i);
    return json(payload());
  };
  const result = await readTenantHistory({ ...expected, getAccessToken: async () => 'example.jwt.token', fetcher, nowMs: NOW });
  assert.equal(called, 1);
  assert.equal(result.ok, true);
});

test('5O missing or invalid bearer never calls network', async () => {
  let calls = 0;
  const fetcher: HistoryFetcher = async () => { calls++; return json(payload()); };
  for (const token of [null, '', 'has space', 'x\r\nheader']) {
    const result = await readTenantHistory({ ...expected, getAccessToken: async () => token, fetcher, nowMs: NOW });
    assert.deepEqual(result, { ok: false, reason: 'authentication_required' });
  }
  assert.equal(calls, 0);
});

test('5O refuses invalid selectors before fetching WorkOS token', async () => {
  let access = 0;
  const result = await readTenantHistory({
    ...expected, organizationId: 'not-an-uuid', getAccessToken: async () => { access++; return 'token'; },
  });
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.equal(access, 0);
});

test('5O maps authentication, access and not-found statuses to safe states', async () => {
  for (const [status, reason] of [
    [401, 'authentication_required'], [403, 'organization_access_denied'],
    [404, 'agent_not_found'], [429, 'unavailable'], [503, 'unavailable'],
  ] as const) {
    const result = await readTenantHistory({ ...expected, getAccessToken: async () => 'safe.token',
      fetcher: async () => new Response('', { status }), nowMs: NOW });
    assert.deepEqual(result, { ok: false, reason });
  }
});

test('5O refuses unexpected media type, bad JSON, oversized JSON and forged payload', async () => {
  const bad: Response[] = [
    new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    json({ ...payload(), organizationId: ORG_B }),
    new Response('x'.repeat(HISTORY_RESPONSE_MAX_BYTES + 5), { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of bad) {
    const result = await readTenantHistory({ ...expected, getAccessToken: async () => 'safe.token',
      fetcher: async () => response, nowMs: NOW });
    assert.equal(result.ok, false);
  }
});

test('5O failures are sanitized even if provider and fetch throw secrets', async () => {
  const provider = await readTenantHistory({ ...expected, getAccessToken: async () => {
    throw new Error('PRIVATE_WORKOS_TOKEN');
  }});
  const network = await readTenantHistory({ ...expected, getAccessToken: async () => 'safe.token',
    fetcher: async () => { throw new Error('PRIVATE_DATABASE_URL'); } });
  assert.deepEqual(provider, { ok: false, reason: 'unavailable' });
  assert.deepEqual(network, { ok: false, reason: 'unavailable' });
  assert.doesNotMatch(JSON.stringify([provider, network]), /PRIVATE_/);
});

test('5O canceled requests do not request an access token', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await readTenantHistory({ ...expected, signal: controller.signal,
    getAccessToken: async () => { calls++; return 'secret'; } });
  assert.equal(calls, 0);
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
});
