/** D15C-5O — honest, read-only historical monitoring display. */
import type { ReactElement } from 'react';
import type { HistoryPoint, HistoryRange, HistoryResponse } from '../server/monitoring/history-contract.js';
import {
  describeHistoryFailure, formatByteRate, formatPercent,
  type DashboardHistoryState,
} from '../monitoring/history-state.js';
import { HISTORY_RANGE_MS } from '../monitoring/history-client.js';

export interface RealHistoryPanelProps {
  readonly state: DashboardHistoryState;
  readonly range: HistoryRange;
  readonly onRangeChange: (range: HistoryRange) => void;
  readonly onRefresh: () => void;
  readonly agentLabel?: string;
}

const RANGES = ['15m', '1h', '24h', '7d'] as const;
const TREND_METRICS = [
  { key: 'cpuUsagePercent', label: 'CPU', color: '#22d3ee' },
  { key: 'memoryUsagePercent', label: 'Memory', color: '#a78bfa' },
  { key: 'diskUsagePercent', label: 'Disk', color: '#fbbf24' },
] as const;

/** Break each trace at missing samples; never interpolate across nulls. */
export function historyTrendSegments(
  history: HistoryResponse,
  field: 'cpuUsagePercent' | 'memoryUsagePercent' | 'diskUsagePercent',
): readonly string[] {
  const end = Date.parse(history.queriedAt);
  const start = end - HISTORY_RANGE_MS[history.range];
  const span = end - start;
  if (!Number.isFinite(end) || span <= 0) return [];
  const segments: string[] = [];
  let current = '';
  let count = 0;
  for (const point of history.points) {
    const value = point[field];
    if (value === null || !Number.isFinite(value)) {
      if (count >= 2) segments.push(current);
      current = '';
      count = 0;
      continue;
    }
    const x = Math.max(0, Math.min(600, ((Date.parse(point.recordedAt) - start) / span) * 600));
    const y = 106 - value;
    const coordinate = `${x.toFixed(2)} ${y.toFixed(2)}`;
    current += `${count === 0 ? 'M' : ' L'}${coordinate}`;
    count++;
  }
  if (count >= 2) segments.push(current);
  return segments;
}

function metricCard(label: string, value: number | null, rate = false): ReactElement {
  return (
    <div key={label} className="rounded-xl border border-neutral-700/70 bg-neutral-950/60 p-4">
      <p className="text-xs uppercase tracking-wider text-neutral-400">{label}</p>
      <p className="mt-2 text-xl font-semibold text-neutral-100">
        {rate ? formatByteRate(value) : formatPercent(value)}
      </p>
    </div>
  );
}

function trend(history: HistoryResponse): ReactElement {
  return (
    <section className="rounded-xl border border-neutral-700/70 bg-neutral-950/50 p-4">
      <div className="mb-3 flex flex-wrap justify-between gap-2">
        <h3 className="text-sm font-semibold text-neutral-100">Recorded utilization trends</h3>
        <span className="text-xs text-neutral-400">0–100% · Missing readings are gaps</span>
      </div>
      <svg viewBox="0 0 600 112" className="h-40 w-full" role="img" aria-label="CPU, memory and disk historical utilization; missing values are not connected">
        <line x1="0" x2="600" y1="106" y2="106" stroke="#52525b" strokeWidth="1" />
        <line x1="0" x2="600" y1="6" y2="6" stroke="#3f3f46" strokeWidth="1" strokeDasharray="4 8" />
        {TREND_METRICS.map(metric =>
          historyTrendSegments(history, metric.key).map((segment, i) => (
            <path key={`${metric.key}-${i}`} d={segment} stroke={metric.color} strokeWidth="2" fill="none" strokeLinejoin="round" />
          )),
        )}
      </svg>
      <div className="mt-2 flex gap-4 text-xs text-neutral-300">
        {TREND_METRICS.map(metric => (
          <span key={metric.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: metric.color }} />
            {metric.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function latestMetrics(history: HistoryResponse): ReactElement {
  const last: HistoryPoint = history.points[history.points.length - 1];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {metricCard('CPU', last.cpuUsagePercent)}
      {metricCard('Memory', last.memoryUsagePercent)}
      {metricCard('Disk', last.diskUsagePercent)}
      {metricCard('Network received', last.networkReceiveBytesPerSecond, true)}
      {metricCard('Network transmitted', last.networkTransmitBytesPerSecond, true)}
    </div>
  );
}

/** No data from other agents, local demo values, browser storage or SSH. */
export function RealHistoryPanel({ state, range, onRangeChange, onRefresh, agentLabel }: RealHistoryPanelProps): ReactElement {
  const hasHistory = 'history' in state;
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-5 text-neutral-100" aria-label="Historical monitoring">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-800 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400">Pulse Metrics</p>
          <h2 className="mt-2 text-xl font-semibold">Historical monitoring{agentLabel ? ` — ${agentLabel}` : ''}</h2>
          <p className="mt-1 text-xs text-neutral-400">Authenticated, read-only PostgreSQL measurements · Not a live status feed</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div aria-label="History range" className="flex gap-1 rounded-lg border border-neutral-700 p-1">
            {RANGES.map(option => (
              <button key={option} type="button" onClick={() => onRangeChange(option)}
                aria-pressed={range === option} disabled={state.phase === 'disabled'}
                className={`rounded px-3 py-1.5 text-xs ${range === option ? 'bg-cyan-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}>
                {option}
              </button>
            ))}
          </div>
          <button type="button" onClick={onRefresh} disabled={state.phase === 'disabled' || state.phase === 'loading'}
            className="rounded-lg border border-neutral-600 px-3 py-2 text-xs hover:bg-neutral-800 disabled:opacity-50">Refresh</button>
        </div>
      </div>
      <div className="mt-5" aria-live="polite">
        {state.phase === 'disabled' && <p role="status" className="text-sm text-amber-300">Historical monitoring has not been enabled for this session.</p>}
        {state.phase === 'loading' && <p role="status" className="text-sm text-neutral-300">Loading authenticated history…</p>}
        {state.phase === 'error' && <p role="alert" className="text-sm text-amber-300">{describeHistoryFailure(state.reason)}</p>}
        {state.phase === 'empty' && <p role="status" className="text-sm text-neutral-300">No recorded telemetry in this time range. This does not establish that the agent is healthy or online.</p>}
        {state.phase === 'stale' && <p role="status" className="mb-4 text-sm text-amber-300">Last recorded telemetry is older than two minutes. Historical readings are not current status.</p>}
        {state.phase === 'unmeasured' && <p role="status" className="mb-4 text-sm text-amber-300">The most recent sample contains no measured CPU, memory, disk or network values.</p>}
        {(state.phase === 'ready' || state.phase === 'stale' || state.phase === 'unmeasured') &&
          <div className="space-y-4">
            {latestMetrics(state.history)}
            {trend(state.history)}
          </div>
        }
        {hasHistory && <p className="mt-4 text-xs text-neutral-400">
          {state.history.points.length} stored points · Queried {state.history.queriedAt}
          {state.history.points.length > 0 ? ` · Latest recorded ${state.history.points.at(-1)?.recordedAt}` : ''}
          {state.history.truncated ? ' · Most recent 500 points only; older rows omitted' : ''}
        </p>}
      </div>
    </section>
  );
}
