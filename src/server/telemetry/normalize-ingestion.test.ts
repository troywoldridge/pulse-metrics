import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InvalidTelemetryError,
  MAX_INGESTION_SAMPLES,
  normalizeTelemetryForIngestion,
} from './normalize-ingestion.js';

const NOW = Date.parse('2026-11-12T20:00:00.000Z');
const TIME = new Date(NOW).toISOString();

function sample(
  metric: string,
  value: number | null,
  unit: string,
  status = 'measured',
) {
  return {
    metric,
    value,
    unit,
    status,
    observedAt: TIME,
  };
}

function envelope(samples: unknown[]) {
  return {
    schemaVersion: 1,
    sentAt: TIME,
    samples,
  };
}

function refuses(input: unknown) {
  assert.throws(
    () => normalizeTelemetryForIngestion(input, NOW),
    InvalidTelemetryError,
  );
}

test('normalizes genuine CPU, memory and disk measurements', () => {
  const result = normalizeTelemetryForIngestion(envelope([
    sample('cpu.usage_percent', 42.5, 'percent'),
    sample('memory.total_bytes', 1000, 'bytes'),
    sample('memory.available_bytes', 250, 'bytes'),
    sample('disk.root.total_bytes', 2000, 'bytes'),
    sample('disk.root.available_bytes', 500, 'bytes'),
  ]), NOW);

  assert.equal(result.cpuUsagePercent, 42.5);
  assert.equal(result.memoryUsagePercent, 75);
  assert.equal(result.diskUsagePercent, 75);
  assert.equal(result.recordedAt, TIME);
  assert.equal(result.schemaVersion, 1);
});

test('never converts cumulative network counters into bandwidth rates', () => {
  const result = normalizeTelemetryForIngestion(envelope([
    sample('network.received_bytes', 1000000, 'bytes'),
    sample('network.transmitted_bytes', 500000, 'bytes'),
  ]), NOW);

  assert.equal(result.networkReceiveBytesPerSecond, null);
  assert.equal(result.networkTransmitBytesPerSecond, null);
  assert.equal(result.metrics['network.received_bytes'].value, 1000000);
});

test('preserves unavailable readings without inventing utilization', () => {
  const result = normalizeTelemetryForIngestion(envelope([
    sample('memory.total_bytes', 1000, 'bytes'),
    sample('memory.available_bytes', null, 'bytes', 'unavailable'),
  ]), NOW);

  assert.equal(result.memoryUsagePercent, null);
  assert.equal(result.metrics['memory.available_bytes'].status, 'unavailable');
});

test('stale measurements are not promoted to current summary values', () => {
  const result = normalizeTelemetryForIngestion(envelope([
    sample('cpu.usage_percent', 45, 'percent', 'stale'),
  ]), NOW);

  assert.equal(result.cpuUsagePercent, null);
  assert.equal(result.metrics['cpu.usage_percent'].status, 'stale');
});

test('rejects duplicate metrics', () => {
  refuses(envelope([
    sample('cpu.usage_percent', 10, 'percent'),
    sample('cpu.usage_percent', 20, 'percent'),
  ]));
});

test('rejects CPU percentage over 100', () => {
  refuses(envelope([
    sample('cpu.usage_percent', 101, 'percent'),
  ]));
});

test('rejects fractional byte counters', () => {
  refuses(envelope([
    sample('network.received_bytes', 42.5, 'bytes'),
  ]));
});

test('rejects unknown telemetry metrics', () => {
  refuses(envelope([
    sample('unknown.metric', 10, 'percent'),
  ]));
});

test('rejects browser-supplied organization identity', () => {
  refuses({
    ...envelope([sample('cpu.usage_percent', 10, 'percent')]),
    organizationId: '00000000-0000-4000-8000-000000000001',
  });
});

test('rejects browser-supplied agent identity', () => {
  refuses({
    ...envelope([sample('cpu.usage_percent', 10, 'percent')]),
    agentId: '00000000-0000-4000-8000-000000000002',
  });
});

test('rejects future-dated telemetry', () => {
  refuses({
    ...envelope([sample('cpu.usage_percent', 10, 'percent')]),
    sentAt: new Date(NOW + 600000).toISOString(),
  });
});

test('rejects telemetry older than 24 hours', () => {
  refuses({
    ...envelope([sample('cpu.usage_percent', 10, 'percent')]),
    sentAt: new Date(NOW - 90000000).toISOString(),
  });
});

test('rejects invalid and noncanonical timestamps', () => {
  refuses({
    ...envelope([sample('cpu.usage_percent', 10, 'percent')]),
    sentAt: '2026-11-12',
  });
});

test('rejects a measurement dated after its envelope beyond skew', () => {
  refuses(envelope([{
    ...sample('cpu.usage_percent', 10, 'percent'),
    observedAt: new Date(NOW + 600000).toISOString(),
  }]));
});

test('rejects invalid unit definitions', () => {
  refuses(envelope([
    sample('cpu.usage_percent', 10, 'bytes'),
  ]));
});

test('rejects an excessive number of samples', () => {
  refuses(envelope(
    Array.from(
      { length: MAX_INGESTION_SAMPLES + 1 },
      () => sample('cpu.usage_percent', 10, 'percent'),
    ),
  ));
});

test('rejects empty telemetry envelopes', () => {
  refuses(envelope([]));
});

test('rejects oversized payloads', () => {
  refuses(envelope([{
    ...sample('cpu.usage_percent', 10, 'percent'),
    source: 'x'.repeat(70000),
  }]));
});

test('rejects extra sample properties', () => {
  refuses(envelope([{
    ...sample('cpu.usage_percent', 10, 'percent'),
    command: 'whoami',
  }]));
});

test('rejects available bytes greater than total without inventing percentage', () => {
  const result = normalizeTelemetryForIngestion(envelope([
    sample('memory.total_bytes', 1000, 'bytes'),
    sample('memory.available_bytes', 2000, 'bytes'),
  ]), NOW);

  assert.equal(result.memoryUsagePercent, null);
});

test('does not expose a tenant ID in normalized output', () => {
  const result = normalizeTelemetryForIngestion(envelope([
    sample('cpu.usage_percent', 10, 'percent'),
  ]), NOW);

  assert.equal('organizationId' in result, false);
  assert.equal('agentId' in result, false);
});

test('rejects malformed objects and cyclic payloads', () => {
  refuses(null);
  refuses([]);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  refuses(cyclic);
});
