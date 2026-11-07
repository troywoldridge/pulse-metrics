import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SAMPLING_INTERVAL_MS,
  parseSamplingInterval,
} from './agent-config.js';

test('uses the default interval when no value is provided', () => {
  assert.equal(
    parseSamplingInterval(undefined),
    DEFAULT_SAMPLING_INTERVAL_MS,
  );
});

test('accepts a valid custom sampling interval', () => {
  assert.equal(parseSamplingInterval('10000'), 10000);
});

test('accepts the minimum supported interval', () => {
  assert.equal(parseSamplingInterval('1000'), 1000);
});

test('rejects intervals shorter than one second', () => {
  assert.throws(
    () => parseSamplingInterval('999'),
    /at least 1000 milliseconds/,
  );
});

test('rejects non-numeric interval values', () => {
  assert.throws(
    () => parseSamplingInterval('five-seconds'),
    /whole number of milliseconds/,
  );
});

test('rejects decimal interval values', () => {
  assert.throws(
    () => parseSamplingInterval('1500.5'),
    /whole number of milliseconds/,
  );
});

test('rejects unsafe integer values', () => {
  assert.throws(
    () => parseSamplingInterval('999999999999999999999'),
    /at least 1000 milliseconds/,
  );
});
