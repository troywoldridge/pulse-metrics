/**
 * Pulse Metrics — D15A telemetry ingestion validation.
 *
 * Pure, unmounted validation and normalization.
 *
 * No HTTP routes, credentials, database connections or SQL operations.
 * Organization and agent identity MUST come from authenticated server
 * context in a later milestone, never from a telemetry payload.
 *
 * Network counters are cumulative bytes, NOT bytes per second.
 */
import {
  METRIC_UNITS,
  TELEMETRY_SCHEMA_VERSION,
  validateTelemetryEnvelope,
  type MetricName,
  type TelemetryEnvelope,
  type TelemetrySample,
} from '../../agent/telemetry-contract.js';

export const MAX_INGESTION_BYTES = 65_536;
export const MAX_INGESTION_SAMPLES = 100;
export const MAX_TELEMETRY_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SAMPLE_KEYS = new Set([
  'metric', 'value', 'unit', 'observedAt',
  'status', 'source', 'reason',
]);

const ENVELOPE_KEYS = new Set([
  'schemaVersion', 'sentAt', 'samples',
]);

export class InvalidTelemetryError extends Error {
  constructor() {
    super('Invalid telemetry payload');
    this.name = 'InvalidTelemetryError';
  }
}

function reject(): never {
  throw new InvalidTelemetryError();
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    return null;
  }

  const milliseconds = Date.parse(value);

  if (!Number.isFinite(milliseconds)) return null;

  return new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function safeText(value: unknown): boolean {
  return typeof value === 'string' &&
    value.length <= 256 &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function validValue(sample: TelemetrySample): boolean {
  if (sample.status === 'unavailable' ||
      sample.status === 'unsupported') {
    return sample.value === null;
  }

  const value = sample.value;

  if (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0) {
    return false;
  }

  if (sample.metric === 'cpu.usage_percent') {
    return value <= 100;
  }

  if (sample.metric === 'cpu.core_count') {
    return Number.isSafeInteger(value) && value >= 1;
  }

  if (METRIC_UNITS[sample.metric] === 'bytes') {
    return Number.isSafeInteger(value);
  }

  return true;
}

function validSample(
  value: unknown,
  sentAtMs: number,
  nowMs: number,
): value is TelemetrySample {
  if (!plainRecord(value) ||
      !exactKeys(value, SAMPLE_KEYS)) {
    return false;
  }

  const sample = value as unknown as TelemetrySample;

  const observedAtMs = timestampMs(sample.observedAt);

  if (observedAtMs === null ||
      observedAtMs < nowMs - MAX_TELEMETRY_AGE_MS ||
      observedAtMs > nowMs + MAX_CLOCK_SKEW_MS ||
      observedAtMs > sentAtMs + MAX_CLOCK_SKEW_MS) {
    return false;
  }

  if (sample.source !== undefined && !safeText(sample.source)) {
    return false;
  }

  if (sample.reason !== undefined && !safeText(sample.reason)) {
    return false;
  }

  return validValue(sample);
}

export interface NormalizedTelemetry {
  readonly recordedAt: string;
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly cpuUsagePercent: number | null;
  readonly memoryUsagePercent: number | null;
  readonly diskUsagePercent: number | null;
  readonly networkReceiveBytesPerSecond: null;
  readonly networkTransmitBytesPerSecond: null;
  readonly metrics: Record<string, TelemetrySample>;
}

function measuredValue(
  samples: ReadonlyMap<MetricName, TelemetrySample>,
  name: MetricName,
): number | null {
  const sample = samples.get(name);

  return sample?.status === 'measured' &&
    typeof sample.value === 'number'
    ? sample.value
    : null;
}

function utilization(
  samples: ReadonlyMap<MetricName, TelemetrySample>,
  totalName: MetricName,
  availableName: MetricName,
): number | null {
  const total = measuredValue(samples, totalName);
  const available = measuredValue(samples, availableName);

  if (total === null || available === null ||
      total <= 0 || available > total) {
    return null;
  }

  const result = ((total - available) / total) * 100;

  return Number.isFinite(result) &&
    result >= 0 && result <= 100
    ? result
    : null;
}

/**
 * Validate untrusted decoded JSON and produce persistence-ready values.
 *
 * This is NOT an authentication or database authorization function.
 * The caller must independently enforce both before any persistence.
 */
export function normalizeTelemetryForIngestion(
  input: unknown,
  nowMs: number = Date.now(),
): NormalizedTelemetry {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return reject();
  }

  if (!plainRecord(input) ||
      !exactKeys(input, ENVELOPE_KEYS)) {
    return reject();
  }

  let serialized: string;

  try {
    serialized = JSON.stringify(input);
  } catch {
    return reject();
  }

  if (!serialized ||
      Buffer.byteLength(serialized, 'utf8') > MAX_INGESTION_BYTES) {
    return reject();
  }

  if (!validateTelemetryEnvelope(input)) {
    return reject();
  }

  const envelope = input as unknown as TelemetryEnvelope;

  if (envelope.samples.length < 1 ||
      envelope.samples.length > MAX_INGESTION_SAMPLES) {
    return reject();
  }

  const sentAtMs = timestampMs(envelope.sentAt);

  if (sentAtMs === null ||
      sentAtMs < nowMs - MAX_TELEMETRY_AGE_MS ||
      sentAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    return reject();
  }

  const samples = new Map<MetricName, TelemetrySample>();

  for (const sample of envelope.samples) {
    if (!validSample(sample, sentAtMs, nowMs) ||
        samples.has(sample.metric)) {
      return reject();
    }

    samples.set(sample.metric, sample);
  }

  // Preserve statuses and timestamps rather than discarding provenance.
  const metrics: Record<string, TelemetrySample> = Object.create(null);

  for (const [name, sample] of samples) {
    metrics[name] = { ...sample };
  }

  return {
    recordedAt: envelope.sentAt,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    cpuUsagePercent: measuredValue(samples, 'cpu.usage_percent'),
    memoryUsagePercent: utilization(
      samples,
      'memory.total_bytes',
      'memory.available_bytes',
    ),
    diskUsagePercent: utilization(
      samples,
      'disk.root.total_bytes',
      'disk.root.available_bytes',
    ),
    // The agent supplies cumulative byte counters, not rates.
    // A future persisted previous-counter design must calculate rates.
    networkReceiveBytesPerSecond: null,
    networkTransmitBytesPerSecond: null,
    metrics,
  };
}
