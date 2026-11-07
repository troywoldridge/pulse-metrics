import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEMETRY_SCHEMA_VERSION,
  validateTelemetryEnvelope,
  validateTelemetrySample,
  type TelemetryEnvelope,
  type TelemetrySample,
} from './telemetry-contract.js';

const timestamp = '2026-11-07T16:00:00.000Z';

function sample(
  overrides: Partial<TelemetrySample> = {},
): TelemetrySample {
  return {
    metric: 'cpu.usage_percent',
    value: 42.5,
    unit: 'percent',
    observedAt: timestamp,
    status: 'measured',
    source: '/proc/stat',
    ...overrides,
  };
}

function envelope(
  samples: TelemetrySample[] = [sample()],
): TelemetryEnvelope {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    sentAt: timestamp,
    samples,
  };
}

test('accepts a valid measured telemetry sample', () => {
  assert.equal(validateTelemetrySample(sample()), true);
});

test('accepts stale measurements with their last known value', () => {
  assert.equal(
    validateTelemetrySample(
      sample({ status: 'stale', value: 42.5 }),
    ),
    true,
  );
});

test('accepts unavailable measurements with null values', () => {
  assert.equal(
    validateTelemetrySample(
      sample({
        value: null,
        status: 'unavailable',
        reason: 'Waiting for another sample.',
      }),
    ),
    true,
  );
});

test('accepts unsupported measurements with null values', () => {
  assert.equal(
    validateTelemetrySample(
      sample({
        value: null,
        status: 'unsupported',
        reason: 'Not supported by this agent.',
      }),
    ),
    true,
  );
});

test('rejects NaN and infinite measurements', () => {
  assert.equal(validateTelemetrySample(sample({ value: Number.NaN })), false);
  assert.equal(validateTelemetrySample(sample({ value: Infinity })), false);
});

test('rejects negative measurements', () => {
  assert.equal(validateTelemetrySample(sample({ value: -1 })), false);
});

test('rejects a numeric value when status is unavailable', () => {
  assert.equal(
    validateTelemetrySample(sample({ status: 'unavailable' })),
    false,
  );
});

test('rejects a null value when status is measured', () => {
  assert.equal(
    validateTelemetrySample(sample({ value: null })),
    false,
  );
});

test('rejects a null value when status is stale', () => {
  assert.equal(
    validateTelemetrySample(sample({ status: 'stale', value: null })),
    false,
  );
});

test('rejects unknown metric names', () => {
  assert.equal(
    validateTelemetrySample({
      ...sample(),
      metric: 'cpu.magic_percent',
    }),
    false,
  );
});

test('rejects incorrect units', () => {
  assert.equal(
    validateTelemetrySample(sample({ unit: 'bytes' })),
    false,
  );
});

test('rejects invalid timestamps', () => {
  assert.equal(
    validateTelemetrySample(sample({ observedAt: 'not-a-date' })),
    false,
  );
});

test('accepts a valid telemetry envelope', () => {
  assert.equal(validateTelemetryEnvelope(envelope()), true);
});

test('rejects an unsupported schema version', () => {
  assert.equal(
    validateTelemetryEnvelope({
      ...envelope(),
      schemaVersion: 99,
    }),
    false,
  );
});

test('rejects an envelope containing an invalid sample', () => {
  assert.equal(
    validateTelemetryEnvelope(
      envelope([sample({ value: Number.NaN })]),
    ),
    false,
  );
});
