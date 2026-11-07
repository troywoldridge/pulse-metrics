import test from 'node:test';
import assert from 'node:assert/strict';

import { LinuxTelemetryCollector } from './linux-collector.js';
import { TelemetrySampler } from './telemetry-sampler.js';

import {
  validateTelemetryEnvelope,
  type TelemetryEnvelope,
} from './telemetry-contract.js';

test(
  'integrates the real Linux collector with the telemetry sampler',
  { skip: process.platform !== 'linux' },
  async () => {
    const receivedEnvelopes: TelemetryEnvelope[] = [];
    const errors: Error[] = [];

    const collector = new LinuxTelemetryCollector();

    const sampler = new TelemetrySampler({
      collector,
      intervalMs: 1000,

      onSample: (envelope) => {
        receivedEnvelopes.push(envelope);
      },

      onError: (error) => {
        errors.push(error);
      },
    });

    // Collect twice so CPU utilization can be calculated
    // from two genuine operating-system counter readings.
    const first = await sampler.runOnce();
    const second = await sampler.runOnce();

    assert.equal(validateTelemetryEnvelope(first), true);
    assert.equal(validateTelemetryEnvelope(second), true);

    assert.equal(receivedEnvelopes.length, 2);
    assert.equal(receivedEnvelopes[0], first);
    assert.equal(receivedEnvelopes[1], second);

    assert.equal(errors.length, 0);
    assert.equal(sampler.isRunning, false);

    const firstCpu = first.samples.find(
      (sample) => sample.metric === 'cpu.usage_percent',
    );

    const secondCpu = second.samples.find(
      (sample) => sample.metric === 'cpu.usage_percent',
    );

    assert.equal(firstCpu?.status, 'unavailable');
    assert.equal(firstCpu?.value, null);

    assert.ok(secondCpu);
    assert.ok(
      secondCpu.status === 'measured' ||
      secondCpu.status === 'unavailable',
    );

    for (const envelope of receivedEnvelopes) {
      assert.equal(validateTelemetryEnvelope(envelope), true);

      for (const sample of envelope.samples) {
        if (sample.status === 'measured') {
          assert.equal(typeof sample.value, 'number');
          assert.ok(Number.isFinite(sample.value));
        }
      }
    }

    const secondMetrics = new Set(
      second.samples.map((sample) => sample.metric),
    );

    assert.ok(secondMetrics.has('memory.total_bytes'));
    assert.ok(secondMetrics.has('memory.available_bytes'));
    assert.ok(secondMetrics.has('disk.root.total_bytes'));
    assert.ok(secondMetrics.has('system.uptime_seconds'));
  },
);
