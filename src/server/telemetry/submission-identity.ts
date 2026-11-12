/**
 * Pulse Metrics — D15B submission identity foundation.
 *
 * Pure, unmounted preparation of telemetry submission metadata.
 *
 * The server must authenticate the machine independently.
 * Organization and agent identity MUST be derived from the
 * authenticated credential, never the submitted envelope or ID.
 *
 * PostgreSQL must eventually enforce uniqueness atomically within
 * the authenticated organization/agent boundary.
 */
import { createHash } from 'node:crypto';
import type { TelemetrySample } from '../../agent/telemetry-contract.js';
import {
  normalizeTelemetryForIngestion,
  type NormalizedTelemetry,
} from './normalize-ingestion.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class InvalidSubmissionIdentityError extends Error {
  constructor() {
    super('Invalid telemetry submission identity');
    this.name = 'InvalidSubmissionIdentityError';
  }
}

export interface PreparedTelemetrySubmission {
  readonly submissionId: string;
  readonly payloadSha256: string;
  readonly telemetry: NormalizedTelemetry;
}

export function isValidSubmissionId(
  value: unknown,
): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function canonicalSample(sample: TelemetrySample) {
  return {
    metric: sample.metric,
    value: sample.value,
    unit: sample.unit,
    observedAt: sample.observedAt,
    status: sample.status,
    ...(sample.source !== undefined
      ? { source: sample.source }
      : {}),
    ...(sample.reason !== undefined
      ? { reason: sample.reason }
      : {}),
  };
}

/**
 * Produce a deterministic digest independent of sample ordering.
 *
 * This digest describes validated content, NOT its authorized owner.
 * It is not a credential, signature, authentication token, or
 * replacement for database transaction-level authorization.
 */
export function fingerprintNormalizedTelemetry(
  telemetry: NormalizedTelemetry,
): string {
  const samples = Object.keys(telemetry.metrics)
    .sort()
    .map(name => canonicalSample(telemetry.metrics[name]));

  const canonical = JSON.stringify({
    schemaVersion: telemetry.schemaVersion,
    recordedAt: telemetry.recordedAt,
    samples,
  });

  return createHash('sha256')
    .update(canonical, 'utf8')
    .digest('hex');
}

/**
 * Validate untrusted telemetry before producing an identity-bound
 * persistence request.
 *
 * The UUID is provided by a future authenticated agent transport.
 * It must be generated ONCE per original submission and reused
 * unchanged for retries.
 *
 * A future database operation must use:
 *
 * (authenticated organization, authenticated agent, submissionId)
 *
 * as its uniqueness key. Matching fingerprints are duplicates;
 * differing fingerprints for an existing key are conflicts.
 */
export function prepareTelemetrySubmission(
  submissionId: unknown,
  envelope: unknown,
  nowMs: number = Date.now(),
): PreparedTelemetrySubmission {
  if (!isValidSubmissionId(submissionId)) {
    throw new InvalidSubmissionIdentityError();
  }

  const telemetry = normalizeTelemetryForIngestion(
    envelope,
    nowMs,
  );

  return {
    submissionId,
    payloadSha256: fingerprintNormalizedTelemetry(telemetry),
    telemetry,
  };
}
