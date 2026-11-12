/**
 * Pulse Metrics — D15B PostgreSQL ingestion gateway.
 *
 * UNMOUNTED FOUNDATION.
 *
 * Calls a future, separately reviewed, atomic PostgreSQL function.
 * No database connection is opened on import.
 * No HTTP handler, route, credential vault, or network transport.
 *
 * The database function MUST verify the machine credential, its
 * telemetry:write scope, expiry and revocation while protecting
 * the subsequent insert against concurrent credential revocation.
 *
 * Organization and agent IDs are NEVER supplied by the caller.
 */
import { sql, type SQL } from 'drizzle-orm';

import {
  hashAgentSecret,
  isCanonicalSecret,
} from '../agent-credential-policy.js';

import {
  prepareTelemetrySubmission,
} from './submission-identity.js';

export type TelemetrySqlExecutor =
  (statement: SQL) => Promise<unknown>;

export type TelemetryPersistenceOutcome =
  'inserted' | 'duplicate';

export class InvalidMachineCredentialError extends Error {
  constructor() {
    super('Invalid machine credential');
    this.name = 'InvalidMachineCredentialError';
  }
}

export class TelemetryPersistenceUnavailable extends Error {
  constructor() {
    super('Telemetry persistence unavailable');
    this.name = 'TelemetryPersistenceUnavailable';
  }
}

export class TelemetrySubmissionConflict extends Error {
  constructor() {
    super('Telemetry submission conflict');
    this.name = 'TelemetrySubmissionConflict';
  }
}

function parseOutcome(result: unknown):
  'inserted' | 'duplicate' | 'conflict' {
  if (
    !result ||
    typeof result !== 'object' ||
    !('rows' in result) ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1
  ) {
    throw new TelemetryPersistenceUnavailable();
  }

  const row: unknown = result.rows[0];

  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    !('outcome' in row)
  ) {
    throw new TelemetryPersistenceUnavailable();
  }

  const outcome = row.outcome;

  if (
    outcome !== 'inserted' &&
    outcome !== 'duplicate' &&
    outcome !== 'conflict'
  ) {
    throw new TelemetryPersistenceUnavailable();
  }

  return outcome;
}

/**
 * Explicit dependency injection preserves existing database
 * ownership and permissions. No implicit database connection.
 *
 * The future SQL function must implement ALL authorization and
 * persistence atomically. This TypeScript gateway cannot replace
 * those database security requirements.
 */
export function createPostgresTelemetryIngestionGateway(
  execute: TelemetrySqlExecutor,
) {
  if (typeof execute !== 'function') {
    throw new TypeError('Explicit SQL executor required');
  }

  return {
    async ingest(
      machineSecret: unknown,
      submissionId: unknown,
      envelope: unknown,
      nowMs: number = Date.now(),
    ): Promise<TelemetryPersistenceOutcome> {
      if (!isCanonicalSecret(machineSecret)) {
        throw new InvalidMachineCredentialError();
      }

      // Validate BEFORE accessing PostgreSQL.
      const prepared = prepareTelemetrySubmission(
        submissionId,
        envelope,
        nowMs,
      );

      const credentialHash = hashAgentSecret(machineSecret);
      const telemetry = prepared.telemetry;

      // JSON parameters are explicitly cast to jsonb.
      // All values are parameterized; no SQL string concatenation.
      const metricsJson = JSON.stringify(telemetry.metrics);

      let result: unknown;

      try {
        result = await execute(sql`
          SELECT pulse_telemetry_ingestion.ingest_submission(
            ${credentialHash}::text,
            ${prepared.submissionId}::uuid,
            ${prepared.payloadSha256}::text,
            ${telemetry.recordedAt}::timestamptz,
            ${telemetry.schemaVersion}::integer,
            ${telemetry.cpuUsagePercent}::real,
            ${telemetry.memoryUsagePercent}::real,
            ${telemetry.diskUsagePercent}::real,
            ${telemetry.networkReceiveBytesPerSecond}::bigint,
            ${telemetry.networkTransmitBytesPerSecond}::bigint,
            ${metricsJson}::jsonb
          ) AS outcome
        `);
      } catch {
        // Never return driver errors, connection details, SQL or secrets.
        throw new TelemetryPersistenceUnavailable();
      }

      const outcome = parseOutcome(result);

      if (outcome === 'conflict') {
        throw new TelemetrySubmissionConflict();
      }

      return outcome;
    },
  };
}
