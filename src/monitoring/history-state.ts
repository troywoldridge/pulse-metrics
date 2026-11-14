/** D15C-5O — presentation state derived solely from verified history. */
import type { HistoryResponse } from '../server/monitoring/history-contract.js';
import type { HistoryReadFailure, HistoryReadResult } from './history-client.js';

export const HISTORY_STALE_AFTER_MS = 2 * 60_000;
export type HistoryDataPhase = 'ready' | 'stale' | 'empty' | 'unmeasured';
export type DashboardHistoryState =
  | { readonly phase: 'disabled' | 'loading' }
  | { readonly phase: 'error'; readonly reason: HistoryReadFailure }
  | { readonly phase: HistoryDataPhase; readonly history: HistoryResponse };

export function historyDisplayState(result: HistoryReadResult, nowMs: number): DashboardHistoryState {
  if (!result.ok) return { phase: 'error', reason: result.reason };
  const history = result.history;
  if (history.points.length === 0) return { phase: 'empty', history };
  const latest = history.points[history.points.length - 1];
  const recorded = Date.parse(latest.recordedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(recorded) || recorded > nowMs + 60_000) {
    return { phase: 'error', reason: 'invalid_response' };
  }
  if (nowMs - recorded > HISTORY_STALE_AFTER_MS) return { phase: 'stale', history };
  const measured = [
    latest.cpuUsagePercent, latest.memoryUsagePercent, latest.diskUsagePercent,
    latest.networkReceiveBytesPerSecond, latest.networkTransmitBytesPerSecond,
  ];
  if (measured.every(value => value === null)) return { phase: 'unmeasured', history };
  return { phase: 'ready', history };
}

export function describeHistoryFailure(reason: HistoryReadFailure): string {
  switch (reason) {
    case 'authentication_required': return 'Your session is not verified. Sign in again before requesting monitoring history.';
    case 'organization_access_denied': return 'You are not authorized to view this organization.';
    case 'agent_not_found': return 'That monitored agent is unavailable to this organization.';
    case 'invalid_response': return 'The monitoring API returned an invalid response. No readings can be trusted.';
    case 'unavailable': return 'Monitoring history is currently unavailable. No readings are being shown.';
  }
}

export function formatPercent(value: number | null): string {
  return value === null ? 'Not measured' : `${value.toFixed(1)}%`;
}

export function formatByteRate(value: number | null): string {
  return value === null ? 'Not measured' : `${value.toLocaleString('en-US')} B/s`;
}
