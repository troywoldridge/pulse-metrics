import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InvalidIngestionDecisionV2,
  parseIngestionDecisionV2,
} from './ingestion-outcome-v2.js';

test('D15C-4A preserves inserted outcome without a retry', () => {
  assert.deepEqual(parseIngestionDecisionV2('inserted'), {
    outcome: 'inserted', retryAfterSeconds: 0,
  });
});

test('D15C-4A preserves verified duplicate outcome without a retry', () => {
  assert.deepEqual(parseIngestionDecisionV2('duplicate'), {
    outcome: 'duplicate', retryAfterSeconds: 0,
  });
});

test('D15C-4A preserves submission conflict outcome', () => {
  assert.deepEqual(parseIngestionDecisionV2('conflict'), {
    outcome: 'conflict', retryAfterSeconds: 0,
  });
});

test('D15C-4A accepts the smallest bounded retry interval', () => {
  assert.deepEqual(parseIngestionDecisionV2('rate_limited:1'), {
    outcome: 'rate_limited', retryAfterSeconds: 1,
  });
});

test('D15C-4A accepts the largest bounded retry interval', () => {
  assert.deepEqual(parseIngestionDecisionV2('rate_limited:900'), {
    outcome: 'rate_limited', retryAfterSeconds: 900,
  });
});

test('D15C-4A accepts an ordinary rate-limited interval', () => {
  assert.deepEqual(parseIngestionDecisionV2('rate_limited:45'), {
    outcome: 'rate_limited', retryAfterSeconds: 45,
  });
});

test('D15C-4A refuses malformed and noncanonical rate-limit outcomes', () => {
  const invalid = [
    'rate_limited', 'rate_limited:', 'rate_limited:0',
    'rate_limited:00', 'rate_limited:01', 'rate_limited:0900',
    'rate_limited:901', 'rate_limited:1000',
    'rate_limited:-1', 'rate_limited:+1', 'rate_limited:2.5',
    'rate_limited:1e2', 'rate_limited: 1', 'rate_limited:1 ',
    'rate_limited:1\n', 'rate_limited:١', 'rate_limited:Infinity',
  ];
  for (const value of invalid) {
    assert.throws(() => parseIngestionDecisionV2(value), InvalidIngestionDecisionV2);
  }
});

test('D15C-4A refuses unrecognized success-looking strings', () => {
  const invalid = ['ok', 'accepted', 'success', 'inserted ', 'duplicate\n', 'conflict:1'];
  for (const value of invalid) {
    assert.throws(() => parseIngestionDecisionV2(value), InvalidIngestionDecisionV2);
  }
});

test('D15C-4A refuses null, undefined and numeric database results', () => {
  for (const value of [null, undefined, 0, 1, 60, NaN, Infinity, true, false]) {
    assert.throws(() => parseIngestionDecisionV2(value), InvalidIngestionDecisionV2);
  }
});

test('D15C-4A refuses objects, arrays and spoofed result wrappers', () => {
  const invalid = [
    {}, [], ['inserted'], { outcome: 'inserted' },
    { outcome: 'rate_limited:60', retryAfterSeconds: 60 },
    new String('inserted'),
  ];
  for (const value of invalid) {
    assert.throws(() => parseIngestionDecisionV2(value), InvalidIngestionDecisionV2);
  }
});

test('D15C-4A refuses embedded control characters', () => {
  const invalid = [
    'rate_limited:12\0', 'rate_limited:12\r\n',
    '\trate_limited:12', 'rate_limited:12\u2028',
  ];
  for (const value of invalid) {
    assert.throws(() => parseIngestionDecisionV2(value), InvalidIngestionDecisionV2);
  }
});

test('D15C-4A parses every permitted retry duration from 1 to 900', () => {
  for (let seconds = 1; seconds <= 900; seconds++) {
    assert.deepEqual(parseIngestionDecisionV2(`rate_limited:${seconds}`), {
      outcome: 'rate_limited', retryAfterSeconds: seconds,
    });
  }
});


test('D15C-4E recognizes only an explicit credential rejection', () => {
  assert.deepEqual(parseIngestionDecisionV2('credential_unavailable'), {
    outcome: 'credential_unavailable', retryAfterSeconds: 0,
  });
});

test('D15C-4E refuses approximations of credential rejection', () => {
  for (const value of [
    'credential unavailable', 'credential_unavailable ',
    'credential_unavailable:0', 'invalid_machine_credential',
    'credential_unavailable\n', '42501', 42501,
  ]) {
    assert.throws(() => parseIngestionDecisionV2(value), InvalidIngestionDecisionV2);
  }
});
