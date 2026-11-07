/**
 * Pulse Metrics — Version 1 telemetry contract.
 *
 * Organization identity is intentionally excluded. The SaaS server derives
 * organization and agent identity from the authenticated agent credential.
 */

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export type MetricAvailability =
  | 'measured'
  | 'stale'
  | 'unavailable'
  | 'unsupported';

export type MetricName =
  | 'cpu.usage_percent'
  | 'cpu.core_count'
  | 'cpu.load_1m'
  | 'cpu.load_5m'
  | 'cpu.load_15m'
  | 'memory.total_bytes'
  | 'memory.available_bytes'
  | 'swap.total_bytes'
  | 'swap.free_bytes'
  | 'disk.root.total_bytes'
  | 'disk.root.available_bytes'
  | 'network.received_bytes'
  | 'network.transmitted_bytes'
  | 'system.uptime_seconds';

export type MetricUnit =
  | 'percent'
  | 'cores'
  | 'load'
  | 'bytes'
  | 'seconds';

export interface TelemetrySample {
  metric: MetricName;
  value: number | null;
  unit: MetricUnit;
  observedAt: string;
  status: MetricAvailability;
  source?: string;
  reason?: string;
}

export interface TelemetryEnvelope {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  sentAt: string;
  samples: TelemetrySample[];
}

export const METRIC_UNITS: Record<MetricName, MetricUnit> = {
  'cpu.usage_percent': 'percent',
  'cpu.core_count': 'cores',
  'cpu.load_1m': 'load',
  'cpu.load_5m': 'load',
  'cpu.load_15m': 'load',
  'memory.total_bytes': 'bytes',
  'memory.available_bytes': 'bytes',
  'swap.total_bytes': 'bytes',
  'swap.free_bytes': 'bytes',
  'disk.root.total_bytes': 'bytes',
  'disk.root.available_bytes': 'bytes',
  'network.received_bytes': 'bytes',
  'network.transmitted_bytes': 'bytes',
  'system.uptime_seconds': 'seconds',
};

const VALID_METRICS = new Set<string>(Object.keys(METRIC_UNITS));

const VALID_STATUSES = new Set<MetricAvailability>([
  'measured',
  'stale',
  'unavailable',
  'unsupported',
]);

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateTelemetrySample(
  sample: unknown,
): sample is TelemetrySample {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    return false;
  }

  const candidate = sample as Record<string, unknown>;

  if (
    typeof candidate.metric !== 'string' ||
    !VALID_METRICS.has(candidate.metric) ||
    typeof candidate.unit !== 'string' ||
    candidate.unit !== METRIC_UNITS[candidate.metric as MetricName] ||
    !isValidTimestamp(candidate.observedAt) ||
    typeof candidate.status !== 'string' ||
    !VALID_STATUSES.has(candidate.status as MetricAvailability)
  ) {
    return false;
  }

  if (
    candidate.status === 'measured' ||
    candidate.status === 'stale'
  ) {
    return (
      typeof candidate.value === 'number' &&
      Number.isFinite(candidate.value) &&
      candidate.value >= 0
    );
  }

  return candidate.value === null;
}

export function validateTelemetryEnvelope(
  envelope: unknown,
): envelope is TelemetryEnvelope {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return false;
  }

  const candidate = envelope as Record<string, unknown>;

  return (
    candidate.schemaVersion === TELEMETRY_SCHEMA_VERSION &&
    isValidTimestamp(candidate.sentAt) &&
    Array.isArray(candidate.samples) &&
    candidate.samples.length <= 1000 &&
    candidate.samples.every(validateTelemetrySample)
  );
}
