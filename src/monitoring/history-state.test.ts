import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryResponse } from '../server/monitoring/history-contract.js';
import { describeHistoryFailure, formatByteRate, formatPercent, historyDisplayState } from './history-state.js';

const NOW = Date.parse('2026-11-14T18:00:00.000Z');
function result(overrides: Partial<HistoryResponse> = {}) {
  const history: HistoryResponse = {
    organizationId: '3a1b0011-0fd2-4a45-b711-32ef63ce0178',
    agentId: '3a1b0022-0fd2-4a45-b711-32ef63ce0178',
    range: '1h', queriedAt: '2026-11-14T17:59:59.000Z', truncated: false,
    points: [{ recordedAt: '2026-11-14T17:59:30.000Z', receivedAt: '2026-11-14T17:59:31.000Z',
      cpuUsagePercent: 0, memoryUsagePercent: null, diskUsagePercent: null,
      networkReceiveBytesPerSecond: null, networkTransmitBytesPerSecond: null }], ...overrides,
  };
  return { ok: true as const, history };
}

test('5O distinguishes genuine measured zero from missing values', () => {
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(null), 'Not measured');
  assert.equal(formatByteRate(0), '0 B/s');
  assert.equal(formatByteRate(null), 'Not measured');
  assert.equal(historyDisplayState(result(), NOW).phase, 'ready');
});

test('5O empty history remains empty, not healthy or offline', () => {
  assert.equal(historyDisplayState(result({ points: [] }), NOW).phase, 'empty');
});

test('5O older-than-two-minute telemetry is explicitly stale', () => {
  const stale = result({ points: [{ ...result().history.points[0], recordedAt: '2026-11-14T17:56:59.000Z' }] });
  assert.equal(historyDisplayState(stale, NOW).phase, 'stale');
});

test('5O latest all-null values cannot appear as healthy', () => {
  const emptyPoint = { ...result().history.points[0], cpuUsagePercent: null };
  assert.equal(historyDisplayState(result({ points: [emptyPoint] }), NOW).phase, 'unmeasured');
});

test('5O invalid future timestamp rejects status rather than showing health', () => {
  const futurePoint = { ...result().history.points[0], recordedAt: '2026-11-14T18:30:00.000Z' };
  assert.deepEqual(historyDisplayState(result({ points: [futurePoint] }), NOW),
    { phase: 'error', reason: 'invalid_response' });
});

test('5O server and auth errors have user-safe copy', () => {
  for (const reason of ['authentication_required', 'organization_access_denied',
    'agent_not_found', 'invalid_response', 'unavailable'] as const) {
    assert.deepEqual(historyDisplayState({ ok: false, reason }, NOW), { phase: 'error', reason });
    assert.ok(describeHistoryFailure(reason).length > 15);
    assert.doesNotMatch(describeHistoryFailure(reason), /password|database url|secret|SQL query/i);
  }
});
