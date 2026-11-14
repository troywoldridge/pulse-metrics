import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LocalHistoryPreviewDenied,
  requireLocalHistoryPreview,
} from './history-preview-policy.js';

const valid = Object.freeze({
  NODE_ENV: 'development',
  PULSE_HISTORY_PREVIEW: 'read-only',
  DATABASE_URL: 'postgresql://pulse_metrics_app:secret@127.0.0.1:5432/pulse_metrics',
});

test('5N exact local opt-in allows only loopback preview', () => {
  assert.deepEqual(requireLocalHistoryPreview(valid), {
    bindAddress: '127.0.0.1', port: 3077,
  });
  assert.deepEqual(requireLocalHistoryPreview({ ...valid, PULSE_HISTORY_PREVIEW_PORT: '3101' }), {
    bindAddress: '127.0.0.1', port: 3101,
  });
});

test('5N missing flag or production mode denies before any connection', () => {
  const cases = [
    { ...valid, PULSE_HISTORY_PREVIEW: undefined },
    { ...valid, PULSE_HISTORY_PREVIEW: 'enabled' },
    { ...valid, NODE_ENV: 'production' },
    { ...valid, NODE_ENV: 'test' },
    { ...valid, NODE_ENV: undefined },
  ];
  for (const environment of cases) {
    assert.throws(() => requireLocalHistoryPreview(environment), LocalHistoryPreviewDenied);
  }
});

test('5N refuses remote, socket override, tunnel, wrong role or DB', () => {
  const bad = [
    'postgresql://pulse_metrics_migrator:x@127.0.0.1:5432/pulse_metrics',
    'postgresql://pulse_metrics_app:x@127.0.0.1:15432/pulse_metrics',
    'postgresql://pulse_metrics_app:x@192.168.4.37:5432/pulse_metrics',
    'postgresql://pulse_metrics_app:x@db.internal:5432/pulse_metrics',
    'postgresql://pulse_metrics_app:x@127.0.0.1:5432/legendary',
    'postgresql://pulse_metrics_app:x@127.0.0.1:5432/pulse_metrics?host=/tmp/fake',
    'postgresql://pulse_metrics_app:x@localhost:5432/pulse_metrics?sslmode=disable',
    'file:///tmp/not-a-database',
    '',
  ];
  for (const DATABASE_URL of bad) {
    assert.throws(() => requireLocalHistoryPreview({ ...valid, DATABASE_URL }), LocalHistoryPreviewDenied);
  }
});

test('5N refuses invalid ports and never grants a wildcard listener', () => {
  for (const PULSE_HISTORY_PREVIEW_PORT of ['0', '80', '5432', '65536', '03077', '-1', '3077 ', '0.0.0.0', '']) {
    assert.throws(() => requireLocalHistoryPreview({ ...valid, PULSE_HISTORY_PREVIEW_PORT }), LocalHistoryPreviewDenied);
  }
});
