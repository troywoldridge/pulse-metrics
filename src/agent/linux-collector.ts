/**
 * Pulse Metrics — Initial Linux telemetry collector.
 *
 * Reads genuine measurements from Linux procfs and filesystem statistics.
 * No shell execution, SSH, random values, or fabricated fallbacks.
 */

import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

import {
  METRIC_UNITS,
  TELEMETRY_SCHEMA_VERSION,
  type MetricName,
  type TelemetryEnvelope,
  type TelemetrySample,
} from './telemetry-contract.js';

export interface CpuCounters {
  total: number;
  idle: number;
}

export interface NetworkCounters {
  receivedBytes: number;
  transmittedBytes: number;
}

export function parseCpuCounters(contents: string): CpuCounters | null {
  const line = contents.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) return null;

  const fields = line.trim().split(/\s+/).slice(1).map(Number);

  // The first eight fields are user, nice, system, idle, iowait,
  // irq, softirq and steal. Guest fields are excluded because Linux
  // already includes guest time in user/nice.
  if (
    fields.length < 8 ||
    fields.slice(0, 8).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    return null;
  }

  const total = fields.slice(0, 8).reduce((sum, value) => sum + value, 0);
  const idle = fields[3] + fields[4];

  if (!Number.isSafeInteger(total) || idle > total) return null;

  return { total, idle };
}

export function calculateCpuUsage(
  previous: CpuCounters,
  current: CpuCounters,
): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;

  if (
    totalDelta <= 0 ||
    idleDelta < 0 ||
    idleDelta > totalDelta
  ) {
    return null;
  }

  const usage = ((totalDelta - idleDelta) / totalDelta) * 100;

  return Number.isFinite(usage)
    ? Math.min(100, Math.max(0, usage))
    : null;
}

export function parseNetworkCounters(
  contents: string,
): NetworkCounters | null {
  let receivedBytes = 0;
  let transmittedBytes = 0;
  let interfaceCount = 0;

  for (const line of contents.split('\n').slice(2)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const interfaceName = line.slice(0, separator).trim();
    if (!interfaceName || interfaceName === 'lo') continue;

    const values = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/)
      .map(Number);

    if (
      values.length < 9 ||
      !Number.isSafeInteger(values[0]) ||
      !Number.isSafeInteger(values[8]) ||
      values[0] < 0 ||
      values[8] < 0
    ) {
      continue;
    }

    receivedBytes += values[0];
    transmittedBytes += values[8];
    interfaceCount += 1;
  }

  if (interfaceCount === 0) return null;

  return { receivedBytes, transmittedBytes };
}

export function parseMemInfo(contents: string): Map<string, number> {
  const values = new Map<string, number>();

  for (const line of contents.split('\n')) {
    const match = line.match(/^([A-Za-z_]+):\s+(\d+)\s+kB$/);
    if (!match) continue;

    const bytes = Number(match[2]) * 1024;

    if (Number.isSafeInteger(bytes)) {
      values.set(match[1], bytes);
    }
  }

  return values;
}

function makeSample(
  metric: MetricName,
  value: number | null,
  status: TelemetrySample['status'],
  observedAt: string,
  source?: string,
  reason?: string,
): TelemetrySample {
  return {
    metric,
    value,
    unit: METRIC_UNITS[metric],
    observedAt,
    status,
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
  };
}

function measured(
  metric: MetricName,
  value: number,
  observedAt: string,
  source: string,
): TelemetrySample {
  if (!Number.isFinite(value) || value < 0) {
    return makeSample(
      metric,
      null,
      'unavailable',
      observedAt,
      source,
      'The operating system returned an invalid measurement.',
    );
  }

  return makeSample(metric, value, 'measured', observedAt, source);
}

function unavailable(
  metric: MetricName,
  observedAt: string,
  source: string,
  reason: string,
): TelemetrySample {
  return makeSample(metric, null, 'unavailable', observedAt, source, reason);
}

export class LinuxTelemetryCollector {
  private previousCpuCounters: CpuCounters | null = null;

  async collect(): Promise<TelemetryEnvelope> {
    if (process.platform !== 'linux') {
      throw new Error(
        'The initial Pulse Metrics collector currently supports Linux only.',
      );
    }

    const sentAt = new Date().toISOString();

    const groups = await Promise.all([
      this.collectCpu(sentAt),
      this.collectMemory(sentAt),
      this.collectSwap(sentAt),
      this.collectDisk(sentAt),
      this.collectNetwork(sentAt),
      this.collectSystem(sentAt),
    ]);

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      sentAt,
      samples: groups.flat(),
    };
  }

  private async collectCpu(timestamp: string): Promise<TelemetrySample[]> {
    const samples: TelemetrySample[] = [];

    try {
      const contents = await readFile('/proc/stat', 'utf8');
      const current = parseCpuCounters(contents);

      if (!current) {
        samples.push(
          unavailable(
            'cpu.usage_percent',
            timestamp,
            '/proc/stat',
            'CPU counters could not be parsed.',
          ),
        );
      } else if (this.previousCpuCounters) {
        const usage = calculateCpuUsage(this.previousCpuCounters, current);

        samples.push(
          usage === null
            ? unavailable(
                'cpu.usage_percent',
                timestamp,
                '/proc/stat',
                'CPU counter changes were invalid.',
              )
            : measured('cpu.usage_percent', usage, timestamp, '/proc/stat'),
        );
      } else {
        samples.push(
          unavailable(
            'cpu.usage_percent',
            timestamp,
            '/proc/stat',
            'Waiting for a second CPU sample to calculate usage.',
          ),
        );
      }

      this.previousCpuCounters = current;
    } catch {
      samples.push(
        unavailable(
          'cpu.usage_percent',
          timestamp,
          '/proc/stat',
          'Unable to read Linux CPU counters.',
        ),
      );
    }

    samples.push(
      measured('cpu.core_count', os.cpus().length, timestamp, 'node:os'),
    );

    const load = os.loadavg();

    samples.push(
      measured('cpu.load_1m', load[0], timestamp, 'node:os'),
      measured('cpu.load_5m', load[1], timestamp, 'node:os'),
      measured('cpu.load_15m', load[2], timestamp, 'node:os'),
    );

    return samples;
  }

  private async collectMemory(timestamp: string): Promise<TelemetrySample[]> {
    try {
      const contents = await readFile('/proc/meminfo', 'utf8');
      const memory = parseMemInfo(contents);

      const total = memory.get('MemTotal');
      const available = memory.get('MemAvailable');

      return [
        total !== undefined
          ? measured('memory.total_bytes', total, timestamp, '/proc/meminfo')
          : unavailable(
              'memory.total_bytes',
              timestamp,
              '/proc/meminfo',
              'MemTotal was not reported.',
            ),
        available !== undefined
          ? measured(
              'memory.available_bytes',
              available,
              timestamp,
              '/proc/meminfo',
            )
          : unavailable(
              'memory.available_bytes',
              timestamp,
              '/proc/meminfo',
              'MemAvailable was not reported.',
            ),
      ];
    } catch {
      return [
        unavailable(
          'memory.total_bytes',
          timestamp,
          '/proc/meminfo',
          'Unable to read Linux memory information.',
        ),
        unavailable(
          'memory.available_bytes',
          timestamp,
          '/proc/meminfo',
          'Unable to read Linux memory information.',
        ),
      ];
    }
  }

  private async collectSwap(timestamp: string): Promise<TelemetrySample[]> {
    try {
      const contents = await readFile('/proc/meminfo', 'utf8');
      const memory = parseMemInfo(contents);

      const total = memory.get('SwapTotal');
      const free = memory.get('SwapFree');

      return [
        total !== undefined
          ? measured('swap.total_bytes', total, timestamp, '/proc/meminfo')
          : unavailable(
              'swap.total_bytes',
              timestamp,
              '/proc/meminfo',
              'SwapTotal was not reported.',
            ),
        free !== undefined
          ? measured('swap.free_bytes', free, timestamp, '/proc/meminfo')
          : unavailable(
              'swap.free_bytes',
              timestamp,
              '/proc/meminfo',
              'SwapFree was not reported.',
            ),
      ];
    } catch {
      return [
        unavailable(
          'swap.total_bytes',
          timestamp,
          '/proc/meminfo',
          'Unable to read Linux swap information.',
        ),
        unavailable(
          'swap.free_bytes',
          timestamp,
          '/proc/meminfo',
          'Unable to read Linux swap information.',
        ),
      ];
    }
  }

  private async collectDisk(timestamp: string): Promise<TelemetrySample[]> {
    try {
      const stats = await statfs('/');
      const total = Number(stats.blocks) * Number(stats.bsize);
      const available = Number(stats.bavail) * Number(stats.bsize);

      return [
        measured('disk.root.total_bytes', total, timestamp, 'statfs:/'),
        measured(
          'disk.root.available_bytes',
          available,
          timestamp,
          'statfs:/',
        ),
      ];
    } catch {
      return [
        unavailable(
          'disk.root.total_bytes',
          timestamp,
          'statfs:/',
          'Unable to read root filesystem capacity.',
        ),
        unavailable(
          'disk.root.available_bytes',
          timestamp,
          'statfs:/',
          'Unable to read root filesystem capacity.',
        ),
      ];
    }
  }

  private async collectNetwork(timestamp: string): Promise<TelemetrySample[]> {
    try {
      const contents = await readFile('/proc/net/dev', 'utf8');
      const counters = parseNetworkCounters(contents);

      if (!counters) {
        return [
          unavailable(
            'network.received_bytes',
            timestamp,
            '/proc/net/dev',
            'No readable non-loopback network interfaces were found.',
          ),
          unavailable(
            'network.transmitted_bytes',
            timestamp,
            '/proc/net/dev',
            'No readable non-loopback network interfaces were found.',
          ),
        ];
      }

      return [
        measured(
          'network.received_bytes',
          counters.receivedBytes,
          timestamp,
          '/proc/net/dev',
        ),
        measured(
          'network.transmitted_bytes',
          counters.transmittedBytes,
          timestamp,
          '/proc/net/dev',
        ),
      ];
    } catch {
      return [
        unavailable(
          'network.received_bytes',
          timestamp,
          '/proc/net/dev',
          'Unable to read Linux network counters.',
        ),
        unavailable(
          'network.transmitted_bytes',
          timestamp,
          '/proc/net/dev',
          'Unable to read Linux network counters.',
        ),
      ];
    }
  }

  private async collectSystem(timestamp: string): Promise<TelemetrySample[]> {
    return [
      measured(
        'system.uptime_seconds',
        os.uptime(),
        timestamp,
        'node:os',
      ),
    ];
  }
}
