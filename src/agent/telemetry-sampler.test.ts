import test from 'node:test';
import assert from 'node:assert/strict';

import { TelemetrySampler } from './telemetry-sampler.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryEnvelope,
} from './telemetry-contract.js';

const envelope: TelemetryEnvelope = {
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  sentAt: '2026-11-07T16:00:00.000Z',
  samples: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

test('runOnce collects and delivers a telemetry envelope', async () => {
  let delivered: TelemetryEnvelope | undefined;

  const sampler = new TelemetrySampler({
    collector: {
      async collect() {
        return envelope;
      },
    },
    intervalMs: 5000,
    onSample(sample) {
      delivered = sample;
    },
    onError() {},
  });

  const result = await sampler.runOnce();

  assert.equal(result, envelope);
  assert.equal(delivered, envelope);
  assert.equal(sampler.isRunning, false);
});

test('concurrent runOnce calls share one collection', async () => {
  const pending = deferred<TelemetryEnvelope>();
  let collectionCount = 0;

  const sampler = new TelemetrySampler({
    collector: {
      collect() {
        collectionCount += 1;
        return pending.promise;
      },
    },
    intervalMs: 5000,
    onSample() {},
    onError() {},
  });

  const first = sampler.runOnce();
  const second = sampler.runOnce();

  assert.equal(collectionCount, 1);

  pending.resolve(envelope);

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult, envelope);
  assert.equal(secondResult, envelope);
  assert.equal(collectionCount, 1);
});

test('reports collector errors to the caller', async () => {
  const expected = new Error('Collector unavailable');

  const sampler = new TelemetrySampler({
    collector: {
      async collect() {
        throw expected;
      },
    },
    intervalMs: 5000,
    onSample() {},
    onError() {},
  });

  await assert.rejects(sampler.runOnce(), expected);
});

test('rejects intervals shorter than one second', () => {
  assert.throws(
    () =>
      new TelemetrySampler({
        collector: {
          async collect() {
            return envelope;
          },
        },
        intervalMs: 999,
        onSample() {},
        onError() {},
      }),
    /at least 1000 milliseconds/,
  );
});

test('start and stop are safe to call repeatedly', () => {
  const sampler = new TelemetrySampler({
    collector: {
      async collect() {
        return envelope;
      },
    },
    intervalMs: 5000,
    onSample() {},
    onError() {},
  });

  sampler.start();
  sampler.start();

  assert.equal(sampler.isRunning, true);

  sampler.stop();
  sampler.stop();

  assert.equal(sampler.isRunning, false);
});

test('waitForIdle waits for an active collection to finish', async () => {
  const pending = deferred<TelemetryEnvelope>();
  let idleResolved = false;

  const sampler = new TelemetrySampler({
    collector: {
      collect() {
        return pending.promise;
      },
    },
    intervalMs: 5000,
    onSample() {},
    onError() {},
  });

  const collection = sampler.runOnce();

  sampler.stop();

  const idle = sampler.waitForIdle().then(() => {
    idleResolved = true;
  });

  await Promise.resolve();

  assert.equal(idleResolved, false);

  pending.resolve(envelope);

  const result = await collection;
  await idle;

  assert.equal(result, envelope);
  assert.equal(idleResolved, true);
});
