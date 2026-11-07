import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateCpuUsage,
  LinuxTelemetryCollector,
  parseCpuCounters,
  parseMemInfo,
  parseNetworkCounters,
} from './linux-collector.js';

import { validateTelemetryEnvelope } from './telemetry-contract.js';

test('parses Linux aggregate CPU counters', () => {
  const result = parseCpuCounters(
    'cpu  100 20 30 400 10 5 5 0 99 2\n',
  );

  assert.deepEqual(result, {
    total: 570,
    idle: 410,
  });
});

test('rejects malformed CPU counters', () => {
  assert.equal(parseCpuCounters('cpu invalid data\n'), null);
  assert.equal(parseCpuCounters('cpu 1 2 3\n'), null);
  assert.equal(parseCpuCounters('notcpu 1 2 3 4 5 6 7 8\n'), null);
});

test('calculates CPU usage from counter differences', () => {
  const usage = calculateCpuUsage(
    { total: 1000, idle: 700 },
    { total: 1200, idle: 800 },
  );

  assert.equal(usage, 50);
});

test('returns zero when all new CPU time is idle', () => {
  assert.equal(
    calculateCpuUsage(
      { total: 100, idle: 80 },
      { total: 200, idle: 180 },
    ),
    0,
  );
});

test('returns null for invalid CPU counter changes', () => {
  assert.equal(
    calculateCpuUsage(
      { total: 200, idle: 100 },
      { total: 100, idle: 50 },
    ),
    null,
  );

  assert.equal(
    calculateCpuUsage(
      { total: 100, idle: 80 },
      { total: 100, idle: 80 },
    ),
    null,
  );
});

test('parses network counters and excludes loopback', () => {
  const contents = [
    'Inter-| Receive | Transmit',
    ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
    ' lo: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0',
    ' eth0: 5000 50 0 0 0 0 0 0 9000 90 0 0 0 0 0 0',
    ' wlan0: 3000 30 0 0 0 0 0 0 7000 70 0 0 0 0 0 0',
  ].join('\n');

  assert.deepEqual(parseNetworkCounters(contents), {
    receivedBytes: 8000,
    transmittedBytes: 16000,
  });
});

test('returns null when no usable network interface exists', () => {
  const contents = [
    'Inter-| Receive | Transmit',
    ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
    ' lo: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0',
  ].join('\n');

  assert.equal(parseNetworkCounters(contents), null);
});

test('parses Linux memory information into bytes', () => {
  const result = parseMemInfo([
    'MemTotal:       16384000 kB',
    'MemAvailable:    8192000 kB',
    'SwapTotal:       2048000 kB',
    'SwapFree:        1024000 kB',
  ].join('\n'));

  assert.equal(result.get('MemTotal'), 16384000 * 1024);
  assert.equal(result.get('MemAvailable'), 8192000 * 1024);
  assert.equal(result.get('SwapTotal'), 2048000 * 1024);
  assert.equal(result.get('SwapFree'), 1024000 * 1024);
});

test(
  'collects real Linux telemetry and validates repeated samples',
  { skip: process.platform !== 'linux' },
  async () => {
    const collector = new LinuxTelemetryCollector();

    const first = await collector.collect();

    assert.equal(validateTelemetryEnvelope(first), true);

    const firstCpu = first.samples.find(
      (item) => item.metric === 'cpu.usage_percent',
    );

    assert.equal(firstCpu?.status, 'unavailable');
    assert.equal(firstCpu?.value, null);

    const second = await collector.collect();

    assert.equal(validateTelemetryEnvelope(second), true);

    const secondCpu = second.samples.find(
      (item) => item.metric === 'cpu.usage_percent',
    );

    assert.ok(secondCpu);
    assert.ok(
      secondCpu.status === 'measured' ||
      secondCpu.status === 'unavailable',
    );

    for (const item of second.samples) {
      if (item.status === 'measured') {
        assert.equal(typeof item.value, 'number');
        assert.ok(Number.isFinite(item.value));
      }
    }

    assert.ok(
      second.samples.some(
        (item) => item.metric === 'memory.total_bytes',
      ),
    );

    assert.ok(
      second.samples.some(
        (item) => item.metric === 'disk.root.total_bytes',
      ),
    );

    assert.ok(
      second.samples.some(
        (item) => item.metric === 'system.uptime_seconds',
      ),
    );
  },
);
