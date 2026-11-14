/**
 * D15C-5L — exact, read-only historical telemetry contract.
 * No network, SQL, authentication, database access or simulated readings.
 */
export type HistoryRange = '15m' | '1h' | '24h' | '7d';

export interface HistoryRequest {
  readonly organizationId: string;
  readonly agentId: string;
  readonly range: HistoryRange;
  readonly since: Date;
  readonly until: Date;
}

export interface PersistedHistoryRow {
  readonly recordedAt: Date;
  readonly receivedAt: Date;
  readonly cpuUsagePercent: number | null;
  readonly memoryUsagePercent: number | null;
  readonly diskUsagePercent: number | null;
  readonly networkReceiveBytesPerSecond: number | null;
  readonly networkTransmitBytesPerSecond: number | null;
}

export interface HistoryPoint {
  readonly recordedAt: string;
  readonly receivedAt: string;
  readonly cpuUsagePercent: number | null;
  readonly memoryUsagePercent: number | null;
  readonly diskUsagePercent: number | null;
  readonly networkReceiveBytesPerSecond: number | null;
  readonly networkTransmitBytesPerSecond: number | null;
}

export interface HistoryResponse {
  readonly organizationId: string;
  readonly agentId: string;
  readonly range: HistoryRange;
  readonly queriedAt: string;
  readonly truncated: boolean;
  readonly points: readonly HistoryPoint[];
}

export const MAX_HISTORY_POINTS = 500;
const MAX_ROWS_FETCHED = MAX_HISTORY_POINTS + 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RANGE_MS: Readonly<Record<HistoryRange, number>> = Object.freeze({
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
});

export class InvalidHistoryRequestError extends Error {
  constructor() { super('Invalid history request'); this.name = 'InvalidHistoryRequestError'; }
}
export class InvalidHistoryResultError extends Error {
  constructor() { super('Invalid history result'); this.name = 'InvalidHistoryResultError'; }
}

export function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Fail closed on unsupported fields instead of allowing arbitrary selectors. */
export function parseHistoryRequest(
  organizationId: unknown,
  agentId: unknown,
  query: unknown,
  nowMs: number = Date.now(),
): HistoryRequest {
  if (!validUuid(organizationId) || !validUuid(agentId) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !query || typeof query !== 'object' || Array.isArray(query)) {
    throw new InvalidHistoryRequestError();
  }
  const values = query as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.some(key => key !== 'range') || keys.length > 1) {
    throw new InvalidHistoryRequestError();
  }
  const range = keys.length === 0 ? '1h' : values.range;
  if (typeof range !== 'string' || !Object.hasOwn(RANGE_MS, range)) {
    throw new InvalidHistoryRequestError();
  }
  const duration = RANGE_MS[range as HistoryRange];
  return {
    organizationId, agentId, range: range as HistoryRange,
    since: new Date(nowMs - duration), until: new Date(nowMs),
  };
}

function percent(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' &&
    Number.isFinite(value) && value >= 0 && value <= 100);
}
function byteRate(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' &&
    Number.isSafeInteger(value) && value >= 0);
}
function realDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Input MUST be newest-first database rows, bounded to MAX_HISTORY_POINTS+1.
 * Output is oldest-first so charts can render without inventing interpolation.
 * Missing network rates stay null; raw cumulative counters are NOT rates.
 */
export function presentHistory(
  request: HistoryRequest,
  newestFirstRows: readonly PersistedHistoryRow[],
): HistoryResponse {
  if (!validUuid(request.organizationId) || !validUuid(request.agentId) ||
      !Object.hasOwn(RANGE_MS, request.range) ||
      !realDate(request.since) || !realDate(request.until) ||
      !Array.isArray(newestFirstRows) || newestFirstRows.length > MAX_ROWS_FETCHED) {
    throw new InvalidHistoryResultError();
  }
  let previousMs = Infinity;
  for (const row of newestFirstRows) {
    if (!row || !realDate(row.recordedAt) || !realDate(row.receivedAt) ||
        !percent(row.cpuUsagePercent) || !percent(row.memoryUsagePercent) ||
        !percent(row.diskUsagePercent) ||
        !byteRate(row.networkReceiveBytesPerSecond) ||
        !byteRate(row.networkTransmitBytesPerSecond)) {
      throw new InvalidHistoryResultError();
    }
    const t = row.recordedAt.getTime();
    if (t > previousMs || t < request.since.getTime() || t > request.until.getTime()) {
      throw new InvalidHistoryResultError();
    }
    previousMs = t;
  }
  const truncated = newestFirstRows.length > MAX_HISTORY_POINTS;
  const points = newestFirstRows.slice(0, MAX_HISTORY_POINTS).reverse().map(row => ({
    recordedAt: row.recordedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    cpuUsagePercent: row.cpuUsagePercent,
    memoryUsagePercent: row.memoryUsagePercent,
    diskUsagePercent: row.diskUsagePercent,
    networkReceiveBytesPerSecond: row.networkReceiveBytesPerSecond,
    networkTransmitBytesPerSecond: row.networkTransmitBytesPerSecond,
  }));
  return {
    organizationId: request.organizationId,
    agentId: request.agentId,
    range: request.range,
    queriedAt: request.until.toISOString(),
    truncated,
    points,
  };
}

/** Defense against a malformed injected reader accidentally crossing tenants. */
export function validHistoryResponse(value: unknown, request: HistoryRequest): value is HistoryResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectedKeys = ['organizationId', 'agentId', 'range', 'queriedAt', 'truncated', 'points'];
  if (Object.keys(value).length !== expectedKeys.length ||
      expectedKeys.some(key => !Object.hasOwn(value, key))) return false;
  const response = value as Partial<HistoryResponse>;
  if (response.organizationId !== request.organizationId ||
      response.agentId !== request.agentId ||
      response.range !== request.range ||
      response.queriedAt !== request.until.toISOString() ||
      typeof response.truncated !== 'boolean' ||
      !Array.isArray(response.points) || response.points.length > MAX_HISTORY_POINTS) return false;
  const keys = ['recordedAt', 'receivedAt', 'cpuUsagePercent',
    'memoryUsagePercent', 'diskUsagePercent',
    'networkReceiveBytesPerSecond', 'networkTransmitBytesPerSecond'];
  let previous = -Infinity;
  for (const point of response.points) {
    if (!point || typeof point !== 'object' || Array.isArray(point) ||
        Object.keys(point).length !== keys.length || keys.some(key => !Object.hasOwn(point, key))) return false;
    const p = point as HistoryPoint;
    const recorded = Date.parse(p.recordedAt);
    const received = Date.parse(p.receivedAt);
    if (!Number.isFinite(recorded) || !Number.isFinite(received) ||
        new Date(recorded).toISOString() !== p.recordedAt ||
        new Date(received).toISOString() !== p.receivedAt ||
        recorded < request.since.getTime() || recorded > request.until.getTime() ||
        recorded < previous ||
        !percent(p.cpuUsagePercent) || !percent(p.memoryUsagePercent) ||
        !percent(p.diskUsagePercent) ||
        !byteRate(p.networkReceiveBytesPerSecond) ||
        !byteRate(p.networkTransmitBytesPerSecond)) return false;
    previous = recorded;
  }
  return true;
}
