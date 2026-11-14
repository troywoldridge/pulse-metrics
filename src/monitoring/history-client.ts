/**
 * D15C-5O — same-origin, bearer-authenticated historical telemetry client.
 *
 * This module does not trust an HTTP 200 by itself: identity, shapes, time,
 * ordered values and finite numeric ranges must all pass validation.
 * It never supplies user/role authority and never manufactures a measurement.
 */
import type { HistoryRange, HistoryResponse } from '../server/monitoring/history-contract.js';

export type HistoryReadFailure =
  | 'authentication_required'
  | 'organization_access_denied'
  | 'agent_not_found'
  | 'unavailable'
  | 'invalid_response';

export type HistoryReadResult =
  | { readonly ok: true; readonly history: HistoryResponse }
  | { readonly ok: false; readonly reason: HistoryReadFailure };

export type HistoryFetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface HistoryReadOptions {
  readonly organizationId: string;
  readonly agentId: string;
  readonly range: HistoryRange;
  /** Must come from WorkOS getAccessToken(), not a URL or local storage. */
  readonly getAccessToken: () => Promise<string | null>;
  readonly signal?: AbortSignal;
  /** Injection for offline HTTP tests; ordinary use is global fetch. */
  readonly fetcher?: HistoryFetcher;
  readonly nowMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const HISTORY_RESPONSE_MAX_BYTES = 256_000;
export const HISTORY_MAX_POINTS = 500;
export const HISTORY_RANGE_MS = Object.freeze({
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
} as const);

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length &&
    names.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function percent(value: unknown): value is number | null {
  return value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
}

function nonnegativeByteRate(value: unknown): value is number | null {
  return value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

const RESPONSE_KEYS = ['organizationId', 'agentId', 'range', 'queriedAt', 'truncated', 'points'];
const POINT_KEYS = [
  'recordedAt', 'receivedAt', 'cpuUsagePercent', 'memoryUsagePercent',
  'diskUsagePercent', 'networkReceiveBytesPerSecond', 'networkTransmitBytesPerSecond',
];

/** Fail closed on forged ownership, unbounded arrays and noncanonical values. */
export function parseHistoryResponse(
  value: unknown,
  expected: Pick<HistoryReadOptions, 'organizationId' | 'agentId' | 'range'>,
  nowMs: number = Date.now(),
): HistoryResponse | null {
  if (!record(value) || !exact(value, RESPONSE_KEYS) ||
      typeof expected.organizationId !== 'string' || !UUID.test(expected.organizationId) ||
      typeof expected.agentId !== 'string' || !UUID.test(expected.agentId) ||
      !Object.hasOwn(HISTORY_RANGE_MS, expected.range) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      value.organizationId !== expected.organizationId ||
      value.agentId !== expected.agentId ||
      value.range !== expected.range ||
      typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.points) || value.points.length > HISTORY_MAX_POINTS) return null;

  const queryTime = timestamp(value.queriedAt);
  if (queryTime === null || queryTime > nowMs + 60_000 ||
      queryTime < nowMs - 5 * 60_000) return null;

  const earliest = queryTime - HISTORY_RANGE_MS[expected.range];
  let previous = -Infinity;
  for (const point of value.points) {
    if (!record(point) || !exact(point, POINT_KEYS)) return null;
    const recorded = timestamp(point.recordedAt);
    const received = timestamp(point.receivedAt);
    if (recorded === null || received === null ||
        recorded < earliest || recorded > queryTime || recorded < previous ||
        received < recorded - 24 * 60 * 60_000 ||
        !percent(point.cpuUsagePercent) ||
        !percent(point.memoryUsagePercent) ||
        !percent(point.diskUsagePercent) ||
        !nonnegativeByteRate(point.networkReceiveBytesPerSecond) ||
        !nonnegativeByteRate(point.networkTransmitBytesPerSecond)) return null;
    previous = recorded;
  }
  return value as unknown as HistoryResponse;
}

function allowed(options: HistoryReadOptions): boolean {
  return UUID.test(options.organizationId) && UUID.test(options.agentId) &&
    Object.hasOwn(HISTORY_RANGE_MS, options.range) &&
    typeof options.getAccessToken === 'function';
}

async function boundedJson(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(type)) {
    throw new Error('invalid_media_type');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > HISTORY_RESPONSE_MAX_BYTES)) {
    throw new Error('invalid_length');
  }
  // A streaming cap avoids downloading arbitrarily large responses.
  if (!response.body) throw new Error('missing_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > HISTORY_RESPONSE_MAX_BYTES) throw new Error('oversized_json');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Never return thrown fetch/WorkOS error objects, token values or SQL details. */
export async function readTenantHistory(options: HistoryReadOptions): Promise<HistoryReadResult> {
  if (!allowed(options) || (options.signal?.aborted ?? false)) {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const token = await options.getAccessToken();
    if (typeof token !== 'string' || !ACCESS_TOKEN.test(token) ||
        token.length > 16_384) {
      return { ok: false, reason: 'authentication_required' };
    }
    if (options.signal?.aborted) return { ok: false, reason: 'unavailable' };
    const url = `/api/organizations/${options.organizationId}/agents/${options.agentId}/history?range=${options.range}`;
    const response = await (options.fetcher ?? fetch)(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: options.signal,
    });
    if (response.status === 401) return { ok: false, reason: 'authentication_required' };
    if (response.status === 403) return { ok: false, reason: 'organization_access_denied' };
    if (response.status === 404) return { ok: false, reason: 'agent_not_found' };
    if (!response.ok || response.status !== 200) return { ok: false, reason: 'unavailable' };
    const data = await boundedJson(response);
    const history = parseHistoryResponse(data, options, options.nowMs ?? Date.now());
    return history ? { ok: true, history } : { ok: false, reason: 'invalid_response' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
