/**
 * Calculate network rates from two genuine cumulative counter readings.
 * A counter reset or invalid time interval produces no rate.
 */

export interface NetworkCounterSnapshot {
  receivedBytes: number;
  transmittedBytes: number;
  observedAt: string;
}

export interface NetworkRates {
  receivedBytesPerSecond: number;
  transmittedBytesPerSecond: number;
}

export function calculateNetworkRates(
  previous: NetworkCounterSnapshot,
  current: NetworkCounterSnapshot,
): NetworkRates | null {
  const previousTime = Date.parse(previous.observedAt);
  const currentTime = Date.parse(current.observedAt);
  const elapsedMs = currentTime - previousTime;

  if (
    !Number.isFinite(previousTime) ||
    !Number.isFinite(currentTime) ||
    elapsedMs <= 0 ||
    !Number.isSafeInteger(previous.receivedBytes) ||
    !Number.isSafeInteger(previous.transmittedBytes) ||
    !Number.isSafeInteger(current.receivedBytes) ||
    !Number.isSafeInteger(current.transmittedBytes) ||
    previous.receivedBytes < 0 ||
    previous.transmittedBytes < 0 ||
    current.receivedBytes < previous.receivedBytes ||
    current.transmittedBytes < previous.transmittedBytes
  ) {
    return null;
  }

  const elapsedSeconds = elapsedMs / 1000;

  return {
    receivedBytesPerSecond:
      (current.receivedBytes - previous.receivedBytes) / elapsedSeconds,
    transmittedBytesPerSecond:
      (current.transmittedBytes - previous.transmittedBytes) / elapsedSeconds,
  };
}
