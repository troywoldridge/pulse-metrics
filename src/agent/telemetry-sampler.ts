/**
 * Pulse Metrics telemetry sampling engine.
 *
 * The sampler is independent of HTTP, authentication, storage and the UI.
 * It collects immediately, then waits for the configured interval.
 * It never starts a second collection while one is still running.
 */

import type { TelemetryEnvelope } from './telemetry-contract.js';

export interface TelemetryCollector {
  collect(): Promise<TelemetryEnvelope>;
}

export interface TelemetrySamplerOptions {
  collector: TelemetryCollector;
  intervalMs: number;
  onSample: (envelope: TelemetryEnvelope) => void | Promise<void>;
  onError: (error: Error) => void;
}

export class TelemetrySampler {
  private readonly collector: TelemetryCollector;
  private readonly intervalMs: number;
  private readonly onSample: TelemetrySamplerOptions['onSample'];
  private readonly onError: TelemetrySamplerOptions['onError'];

  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<TelemetryEnvelope> | null = null;

  constructor(options: TelemetrySamplerOptions) {
    if (
      !Number.isInteger(options.intervalMs) ||
      options.intervalMs < 1000
    ) {
      throw new Error('Sampling interval must be at least 1000 milliseconds.');
    }

    this.collector = options.collector;
    this.intervalMs = options.intervalMs;
    this.onSample = options.onSample;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Waits for an active collection and its sample callback to finish.
   *
   * Calling stop() first prevents another scheduled collection from starting.
   * Collection errors are left to the original runOnce caller or tick handler.
   */
  async waitForIdle(): Promise<void> {
    const activeOperation = this.inFlight;

    if (!activeOperation) return;

    try {
      await activeOperation;
    } catch {
      // The operation's original caller is responsible for handling its error.
    }
  }

  async runOnce(): Promise<TelemetryEnvelope> {
    // Multiple callers share the same collection instead of starting
    // overlapping operating-system reads.
    if (this.inFlight) return this.inFlight;

    const operation = this.collector.collect().then(async (envelope) => {
      await this.onSample(envelope);
      return envelope;
    });

    this.inFlight = operation;

    try {
      return await operation;
    } finally {
      if (this.inFlight === operation) {
        this.inFlight = null;
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.runOnce();
    } catch (error) {
      this.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    if (this.running) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.tick();
      }, this.intervalMs);
    }
  }
}
