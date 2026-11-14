import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_HISTORY_POINTS, InvalidHistoryRequestError,
  InvalidHistoryResultError, parseHistoryRequest, presentHistory,
  validHistoryResponse, type PersistedHistoryRow,
} from './history-contract.js';

const ORG = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const AGENT = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
const NOW = Date.parse('2026-11-14T15:00:00.000Z');
const request = () => parseHistoryRequest(ORG, AGENT, {}, NOW);
const point = (ms = NOW - 5_000): PersistedHistoryRow => ({
  recordedAt: new Date(ms), receivedAt: new Date(ms + 250),
  cpuUsagePercent: 42.5, memoryUsagePercent: 50, diskUsagePercent: null,
  networkReceiveBytesPerSecond: null, networkTransmitBytesPerSecond: null,
});

test('5L allows only fixed bounded ranges and defaults to 1h', () => {
  assert.equal(request().range, '1h');
  assert.equal(request().since.getTime(), NOW - 3_600_000);
  for (const [range, ms] of [['15m', 900_000], ['1h', 3_600_000], ['24h', 86_400_000], ['7d', 604_800_000]] as const) {
    assert.equal(parseHistoryRequest(ORG, AGENT, { range }, NOW).since.getTime(), NOW - ms);
  }
});

test('5L rejects browser selectors, roles, organization overrides and arbitrary windows', () => {
  for (const query of [{ role: 'owner' }, { userId: ORG }, { agentId: AGENT },
    { since: 0 }, { until: 0 }, { range: '30d' }, { range: ['1h', '7d'] },
    { range: '1h', limit: 10000 }, { range: null }, null, [], 1]) {
    assert.throws(() => parseHistoryRequest(ORG, AGENT, query, NOW), InvalidHistoryRequestError);
  }
});

test('5L refuses malformed organization and agent identities before database lookup', () => {
  for (const id of ['', 'all', '../other', 'not-a-uuid', null, 123]) {
    assert.throws(() => parseHistoryRequest(id, AGENT, {}, NOW), InvalidHistoryRequestError);
    assert.throws(() => parseHistoryRequest(ORG, id, {}, NOW), InvalidHistoryRequestError);
  }
});

test('5L refuses invalid clocks', () => {
  for (const now of [NaN, Infinity, -1, 3.14]) {
    assert.throws(() => parseHistoryRequest(ORG, AGENT, {}, now), InvalidHistoryRequestError);
  }
});

test('5L preserves genuine stored values and nulls, without producing fake bandwidth', () => {
  const response = presentHistory(request(), [point()]);
  assert.equal(response.points.length, 1);
  assert.equal(response.points[0].cpuUsagePercent, 42.5);
  assert.equal(response.points[0].diskUsagePercent, null);
  assert.equal(response.points[0].networkReceiveBytesPerSecond, null);
  assert.equal(response.points[0].networkTransmitBytesPerSecond, null);
  assert.equal(response.points[0].receivedAt, new Date(NOW - 4_750).toISOString());
  assert.equal(response.truncated, false);
  assert.ok(validHistoryResponse(response, request()));
});

test('5L returns an honest empty history, not a healthy state', () => {
  const response = presentHistory(request(), []);
  assert.deepEqual(response.points, []);
  assert.equal(response.truncated, false);
  assert.equal('status' in response, false);
  assert.equal('health' in response, false);
});

test('5L returns newest 500 rows in ascending display order and reports truncation', () => {
  const rows = Array.from({ length: MAX_HISTORY_POINTS + 1 }, (_, i) => point(NOW - (i + 1) * 1_000));
  const response = presentHistory(request(), rows);
  assert.equal(response.points.length, MAX_HISTORY_POINTS);
  assert.equal(response.truncated, true);
  assert.equal(response.points[0].recordedAt, new Date(NOW - 500_000).toISOString());
  assert.equal(response.points.at(-1)?.recordedAt, new Date(NOW - 1_000).toISOString());
});

test('5L rejects unbounded, unsorted, out-of-window or invalid persisted rows', () => {
  const r = request();
  for (const rows of [
    Array.from({ length: MAX_HISTORY_POINTS + 2 }, () => point()),
    [point(NOW - 10_000), point(NOW - 1_000)],
    [point(NOW - 3_700_000)],
    [point(NOW + 1_000)],
    [{ ...point(), cpuUsagePercent: 101 }],
    [{ ...point(), memoryUsagePercent: NaN }],
    [{ ...point(), networkReceiveBytesPerSecond: 10.5 }],
    [{ ...point(), networkTransmitBytesPerSecond: Number.MAX_SAFE_INTEGER + 10 }],
    [{ ...point(), recordedAt: new Date('bad') }],
  ]) {
    assert.throws(() => presentHistory(r, rows), InvalidHistoryResultError);
  }
});

test('5L response validator refuses mismatched tenant, agent or time', () => {
  const r = request(); const response = presentHistory(r, [point()]);
  assert.equal(validHistoryResponse({ ...response, organizationId: AGENT }, r), false);
  assert.equal(validHistoryResponse({ ...response, secret: 'leak' }, r), false);
  assert.equal(validHistoryResponse({ ...response, agentId: ORG }, r), false);
  assert.equal(validHistoryResponse({ ...response, queriedAt: 'wrong' }, r), false);
  assert.equal(validHistoryResponse({ ...response, points: [{ ...response.points[0], cpuUsagePercent: 200 }] }, r), false);
  assert.equal(validHistoryResponse({ ...response, points: [{ ...response.points[0], extraSecret: 'leak' }] }, r), false);
});
