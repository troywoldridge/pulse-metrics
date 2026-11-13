/**
 * Pulse Metrics — D15C-4C PostgreSQL ingestion gateway candidate.
 *
 * UNMOUNTED. NOT APPROVED FOR PRODUCTION.
 *
 * This is a complete rewrite of the gateway to interpret the separately
 * reviewed D15C-4B PostgreSQL quota decision. It does not open a database
 * connection, mount routes, or relax the database authorization boundary.
 *
 * The SQL function itself must still authenticate machine credentials,
 * lock the agent before the credential, validate telemetry, and enforce
 * quota accounting in one standalone autocommit statement.
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

import {
  parseIngestionDecisionV2,
} from './ingestion-outcome-v2.js';

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

export class TelemetryAgentRateLimited extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Telemetry agent quota exceeded');
    this.name = 'TelemetryAgentRateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function parseOutcome(result: unknown):
  | { outcome: 'inserted' | 'duplicate' | 'conflict' | 'credential_unavailable'; retryAfterSeconds: 0 }
  | { outcome: 'rate_limited'; retryAfterSeconds: number } {
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
    Object.keys(row).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(row, 'outcome')
  ) {
    throw new TelemetryPersistenceUnavailable();
  }

  try {
    return parseIngestionDecisionV2(
      (row as { outcome: unknown }).outcome,
    );
  } catch {
    // Unexpected database output is never returned to the agent.
    throw new TelemetryPersistenceUnavailable();
  }
}

/**
 * Explicit dependency injection prevents implicit DB access.
 *
 * IMPORTANT: The executor must issue one standalone PostgreSQL statement,
 * not an operation inside a caller-managed transaction that might later
 * roll back the durable quota denial.
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

      // Reject malformed telemetry before touching PostgreSQL.
      const prepared = prepareTelemetrySubmission(
        submissionId,
        envelope,
        nowMs,
      );

      const credentialHash = hashAgentSecret(machineSecret);
      const telemetry = prepared.telemetry;
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
        // Never leak driver errors, SQL, secrets, or connection details.
        throw new TelemetryPersistenceUnavailable();
      }

      const decision = parseOutcome(result);

      if (decision.outcome === 'credential_unavailable') {
        // Only an explicit protected-function result means HTTP 401.
        // SQLSTATE 42501, outages and driver errors still mean 503.
        throw new InvalidMachineCredentialError();
      }

      if (decision.outcome === 'conflict') {
        throw new TelemetrySubmissionConflict();
      }

      if (decision.outcome === 'rate_limited') {
        throw new TelemetryAgentRateLimited(
          decision.retryAfterSeconds,
        );
      }

      return decision.outcome;
    },
  };
}
