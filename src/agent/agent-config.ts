/**
 * Configuration helpers for the local Pulse Metrics agent.
 */

export const DEFAULT_SAMPLING_INTERVAL_MS = 5000;
export const MINIMUM_SAMPLING_INTERVAL_MS = 1000;

export function parseSamplingInterval(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_SAMPLING_INTERVAL_MS;
  }

  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      'PULSE_AGENT_INTERVAL_MS must be a whole number of milliseconds.',
    );
  }

  const intervalMs = Number(normalized);

  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MINIMUM_SAMPLING_INTERVAL_MS
  ) {
    throw new Error(
      `PULSE_AGENT_INTERVAL_MS must be at least ${MINIMUM_SAMPLING_INTERVAL_MS} milliseconds.`,
    );
  }

  return intervalMs;
}
