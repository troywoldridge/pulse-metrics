import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateNetworkRates } from './network-rate.js';

test('calculates received and transmitted bytes per second', () => {
  const result = calculateNetworkRates(
    {
      receivedBytes: 1000,
      transmittedBytes: 2000,
      observedAt: '2026-11-07T16:00:00.000Z',
    },
    {
      receivedBytes: 3000,
      transmittedBytes: 5000,
      observedAt: '2026-11-07T16:00:02.000Z',
    },
  );

  assert.deepEqual(result, {
    receivedBytesPerSecond: 1000,
    transmittedBytesPerSecond: 1500,
  });
});

test('calculates fractional rates for fractional-second intervals', () => {
  const result = calculateNetworkRates(
    {
      receivedBytes: 100,
      transmittedBytes: 200,
      observedAt: '2026-11-07T16:00:00.000Z',
    },
    {
      receivedBytes: 600,
      transmittedBytes: 1200,
      observedAt: '2026-11-07T16:00:00.500Z',
    },
  );

  assert.deepEqual(result, {
    receivedBytesPerSecond: 1000,
    transmittedBytesPerSecond: 2000,
  });
});

test('returns zero when counters have not changed', () => {
  const result = calculateNetworkRates(
    {
      receivedBytes: 1000,
      transmittedBytes: 2000,
      observedAt: '2026-11-07T16:00:00.000Z',
    },
    {
      receivedBytes: 1000,
      transmittedBytes: 2000,
      observedAt: '2026-11-07T16:00:01.000Z',
    },
  );

  assert.deepEqual(result, {
    receivedBytesPerSecond: 0,
    transmittedBytesPerSecond: 0,
  });
});

test('rejects a reset or decreasing network counter', () => {
  const result = calculateNetworkRates(
    {
      receivedBytes: 5000,
      transmittedBytes: 6000,
      observedAt: '2026-11-07T16:00:00.000Z',
    },
    {
      receivedBytes: 100,
      transmittedBytes: 7000,
      observedAt: '2026-11-07T16:00:01.000Z',
    },
  );

  assert.equal(result, null);
});

test('rejects zero or negative elapsed time', () => {
  const previous = {
    receivedBytes: 100,
    transmittedBytes: 200,
    observedAt: '2026-11-07T16:00:00.000Z',
  };

  assert.equal(
    calculateNetworkRates(previous, {
      ...previous,
      receivedBytes: 200,
    }),
    null,
  );

  assert.equal(
    calculateNetworkRates(previous, {
      receivedBytes: 200,
      transmittedBytes: 300,
      observedAt: '2026-11-07T15:59:59.000Z',
    }),
    null,
  );
});

test('rejects invalid counters and timestamps', () => {
  const previous = {
    receivedBytes: 100,
    transmittedBytes: 200,
    observedAt: '2026-11-07T16:00:00.000Z',
  };

  assert.equal(
    calculateNetworkRates(previous, {
      receivedBytes: Number.NaN,
      transmittedBytes: 300,
      observedAt: '2026-11-07T16:00:01.000Z',
    }),
    null,
  );

  assert.equal(
    calculateNetworkRates(previous, {
      receivedBytes: 200,
      transmittedBytes: 300,
      observedAt: 'invalid',
    }),
    null,
  );
});
