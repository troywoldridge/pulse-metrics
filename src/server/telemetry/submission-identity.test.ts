import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  InvalidSubmissionIdentityError,
  isValidSubmissionId,
  prepareTelemetrySubmission,
} from './submission-identity.js';

import {
  InvalidTelemetryError,
} from './normalize-ingestion.js';

const NOW = Date.parse('2026-11-12T20:00:00.000Z');
const TIME = new Date(NOW).toISOString();

const VALID_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function sample(
  metric: string,
  value: number,
  unit: string,
) {
  return {
    metric,
    value,
    unit,
    status: 'measured',
    observedAt: TIME,
  };
}

function envelope(samples = [
  sample('cpu.usage_percent', 42, 'percent'),
]) {
  return {
    schemaVersion: 1,
    sentAt: TIME,
    samples,
  };
}

test('accepts a canonical UUID v4 submission identity', () => {
  assert.equal(isValidSubmissionId(randomUUID()), true);
  assert.equal(isValidSubmissionId(VALID_UUID), true);
});

test('rejects malformed and non-v4 identities', () => {
  const invalidIds: unknown[] = [
    null,
    undefined,
    '',
    12345,
    'retry-1',
    '00000000-0000-0000-0000-000000000000',

    // UUID v1 instead of v4.
    'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa',

    // UUID v5 instead of v4.
    'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',

    // Invalid UUID variant.
    'aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa',

    // Actual uppercase hexadecimal letters.
    VALID_UUID.toUpperCase(),

    // Mixed-case hexadecimal letters.
    'aAaAaAaA-aaaa-4aaa-8aaa-aaaaaaaaaaaa',

    // Missing separators.
    'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',

    // Unexpected whitespace.
    ` ${VALID_UUID}`,
    `${VALID_UUID} `,
  ];

  for (const value of invalidIds) {
    assert.equal(
      isValidSubmissionId(value),
      false,
      `Unexpectedly accepted submission identity: ${String(value)}`,
    );

    assert.throws(
      () => prepareTelemetrySubmission(value, envelope(), NOW),
      InvalidSubmissionIdentityError,
    );
  }
});

test('same submission and payload produce identical fingerprints', () => {
  const id = randomUUID();

  const first = prepareTelemetrySubmission(
    id,
    envelope(),
    NOW,
  );

  const retry = prepareTelemetrySubmission(
    id,
    envelope(),
    NOW + 1000,
  );

  assert.equal(first.submissionId, retry.submissionId);
  assert.equal(first.payloadSha256, retry.payloadSha256);
  assert.match(first.payloadSha256, /^[0-9a-f]{64}$/);
});

test('sample ordering does not change the fingerprint', () => {
  const id = randomUUID();

  const cpu = sample('cpu.usage_percent', 42, 'percent');
  const memory = sample('memory.total_bytes', 4096, 'bytes');

  const first = prepareTelemetrySubmission(
    id,
    envelope([cpu, memory]),
    NOW,
  );

  const second = prepareTelemetrySubmission(
    id,
    envelope([memory, cpu]),
    NOW,
  );

  assert.equal(first.payloadSha256, second.payloadSha256);
});

test('changed measurements produce a different fingerprint', () => {
  const id = randomUUID();

  const first = prepareTelemetrySubmission(
    id,
    envelope([
      sample('cpu.usage_percent', 42, 'percent'),
    ]),
    NOW,
  );

  const changed = prepareTelemetrySubmission(
    id,
    envelope([
      sample('cpu.usage_percent', 43, 'percent'),
    ]),
    NOW,
  );

  assert.notEqual(first.payloadSha256, changed.payloadSha256);
});

test('changed observation timestamp changes the fingerprint', () => {
  const id = randomUUID();

  const first = prepareTelemetrySubmission(
    id,
    envelope(),
    NOW,
  );

  const changed = prepareTelemetrySubmission(
    id,
    {
      ...envelope(),
      samples: [{
        ...sample('cpu.usage_percent', 42, 'percent'),
        observedAt: new Date(NOW - 1000).toISOString(),
      }],
    },
    NOW,
  );

  assert.notEqual(first.payloadSha256, changed.payloadSha256);
});

test('identity preparation never adds tenant or agent ownership', () => {
  const prepared = prepareTelemetrySubmission(
    randomUUID(),
    envelope(),
    NOW,
  );

  assert.equal('organizationId' in prepared, false);
  assert.equal('agentId' in prepared, false);
  assert.equal('machineCredential' in prepared, false);
});

test('rejects tampered telemetry before generating a submission', () => {
  assert.throws(
    () => prepareTelemetrySubmission(
      randomUUID(),
      {
        ...envelope(),
        organizationId: randomUUID(),
      },
      NOW,
    ),
    InvalidTelemetryError,
  );
});

test('rejects reused metric names within one envelope', () => {
  assert.throws(
    () => prepareTelemetrySubmission(
      randomUUID(),
      envelope([
        sample('cpu.usage_percent', 42, 'percent'),
        sample('cpu.usage_percent', 43, 'percent'),
      ]),
      NOW,
    ),
    InvalidTelemetryError,
  );
});
