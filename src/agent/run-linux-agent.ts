/**
 * Pulse Metrics — Local Linux agent runner.
 *
 * This process collects and validates genuine local Linux telemetry.
 * It does not connect to the dashboard, database, or external services.
 */

import { pathToFileURL } from 'node:url';

import { parseSamplingInterval } from './agent-config.js';
import { LinuxTelemetryCollector } from './linux-collector.js';
import { validateTelemetryEnvelope } from './telemetry-contract.js';
import { TelemetrySampler } from './telemetry-sampler.js';

function reportError(error: unknown): void {
  const normalized =
    error instanceof Error ? error : new Error(String(error));

  console.error(
    JSON.stringify({
      type: 'agent_error',
      timestamp: new Date().toISOString(),
      message: normalized.message,
    }),
  );
}

export function startLinuxAgent(): void {
  if (process.platform !== 'linux') {
    throw new Error('The Pulse Metrics local agent currently supports Linux only.');
  }

  const intervalMs = parseSamplingInterval(
    process.env.PULSE_AGENT_INTERVAL_MS,
  );

  const collector = new LinuxTelemetryCollector();

  const sampler = new TelemetrySampler({
    collector,
    intervalMs,

    onSample(envelope) {
      if (!validateTelemetryEnvelope(envelope)) {
        throw new Error(
          'The collector returned an invalid telemetry envelope. Sample rejected.',
        );
      }

      // Local structured output only. No telemetry is transmitted.
      console.log(
        JSON.stringify({
          type: 'telemetry_sample',
          schemaVersion: envelope.schemaVersion,
          sentAt: envelope.sentAt,
          sampleCount: envelope.samples.length,
          samples: envelope.samples,
        }),
      );
    },

    onError(error) {
      reportError(error);
    },
  });

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    console.log(
      JSON.stringify({
        type: 'agent_shutdown_started',
        signal,
        timestamp: new Date().toISOString(),
      }),
    );

    // Stop future scheduled collections before waiting for the active one.
    sampler.stop();

    shutdownPromise = sampler.waitForIdle().then(() => {
      console.log(
        JSON.stringify({
          type: 'agent_shutdown_complete',
          timestamp: new Date().toISOString(),
        }),
      );
    });

    return shutdownPromise;
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').catch(reportError);
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').catch(reportError);
  });

  console.log(
    JSON.stringify({
      type: 'agent_started',
      platform: process.platform,
      samplingIntervalMs: intervalMs,
      timestamp: new Date().toISOString(),
      telemetryDestination: 'local_terminal_only',
    }),
  );

  sampler.start();
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  try {
    startLinuxAgent();
  } catch (error) {
    reportError(error);
    process.exitCode = 1;
  }
}
