import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HistoryResponse } from '../server/monitoring/history-contract.js';
import { historyTrendSegments, RealHistoryPanel } from './RealHistoryPanel.js';

const HISTORY: HistoryResponse = {
  organizationId: '3a1b0011-0fd2-4a45-b711-32ef63ce0178',
  agentId: '3a1b0022-0fd2-4a45-b711-32ef63ce0178',
  range: '1h', queriedAt: '2026-11-14T17:59:59.000Z', truncated: false,
  points: [
    { recordedAt: '2026-11-14T17:50:00.000Z', receivedAt: '2026-11-14T17:50:00.000Z',
      cpuUsagePercent: 30, memoryUsagePercent: null, diskUsagePercent: 60,
      networkReceiveBytesPerSecond: null, networkTransmitBytesPerSecond: null },
    { recordedAt: '2026-11-14T17:55:00.000Z', receivedAt: '2026-11-14T17:55:00.000Z',
      cpuUsagePercent: null, memoryUsagePercent: 20, diskUsagePercent: 70,
      networkReceiveBytesPerSecond: null, networkTransmitBytesPerSecond: null },
    { recordedAt: '2026-11-14T17:59:30.000Z', receivedAt: '2026-11-14T17:59:30.000Z',
      cpuUsagePercent: 0, memoryUsagePercent: null, diskUsagePercent: null,
      networkReceiveBytesPerSecond: null, networkTransmitBytesPerSecond: 0 },
  ],
};
const noop = () => undefined;
function render(state: Parameters<typeof RealHistoryPanel>[0]['state']): string {
  return renderToStaticMarkup(<RealHistoryPanel state={state} range="1h" onRangeChange={noop} onRefresh={noop} />);
}

test('5O disabled panel shows no invented sample values', () => {
  const html = render({ phase: 'disabled' });
  assert.match(html, /not been enabled/);
  assert.doesNotMatch(html, /0\.0%|100\.0%|healthy|online/i);
});

test('5O loading and unavailable states show no fabricated numbers', () => {
  const loading = render({ phase: 'loading' });
  const unavailable = render({ phase: 'error', reason: 'unavailable' });
  assert.match(loading, /Loading authenticated history/);
  assert.match(unavailable, /history is currently unavailable/i);
  assert.doesNotMatch(loading + unavailable, /0\.0%|healthy|online/i);
});

test('5O data cards show real zero and Not measured; no fake network', () => {
  const html = render({ phase: 'ready', history: HISTORY });
  assert.match(html, /0\.0%/);
  assert.match(html, /0 B\/s/);
  assert.match(html, /Not measured/);
  assert.match(html, /Historical monitoring/);
  assert.doesNotMatch(html, /undefined|NaN|Infinity/);
});

test('5O stale and empty views distinguish a lack of fresh data', () => {
  const stale = render({ phase: 'stale', history: HISTORY });
  const empty = render({ phase: 'empty', history: { ...HISTORY, points: [] } });
  assert.match(stale, /older than two minutes/);
  assert.match(empty, /No recorded telemetry/);
  assert.match(empty, /does not establish that the agent is healthy or online/);
  assert.doesNotMatch(empty, /0\.0%|100\.0%|status: healthy/i);
});

test('5O truncated history is clearly disclosed', () => {
  const html = render({ phase: 'ready', history: { ...HISTORY, truncated: true } });
  assert.match(html, /older rows omitted/);
});

test('5O trend segments never bridge null samples', () => {
  assert.deepEqual(historyTrendSegments(HISTORY, 'cpuUsagePercent'), []);
  assert.equal(historyTrendSegments(HISTORY, 'diskUsagePercent').length, 1);
  assert.deepEqual(historyTrendSegments({ ...HISTORY, points: [] }, 'cpuUsagePercent'), []);
});

test('5O user labels are escaped rather than becoming HTML or JS', () => {
  const html = renderToStaticMarkup(<RealHistoryPanel state={{ phase: 'empty', history: HISTORY }}
    range="1h" onRangeChange={noop} onRefresh={noop} agentLabel={'<script>alert(1)</script>'} />);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
