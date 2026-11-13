/**
 * Pulse Metrics — D15C-3A telemetry network quota candidate.
 *
 * UNMOUNTED. REVIEW-ONLY. NOT PRODUCTION READY.
 *
 * Network quotas are separate from agent enrollment quotas.
 * A caller must explicitly inject a quota consumer.
 *
 * The future PostgreSQL migration must provide:
 *
 * pulse_telemetry_quota.consume_network_quota(text)
 *
 * The SQL function does not exist as part of this file.
 * Do not connect this adapter to a live database yet.
 */

import { createHmac } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

import {
  canonicalClientAddress,
} from './trusted-client-address.js';

import {
  TelemetryIngressRateLimited,
} from './telemetry-ingress.js';

export interface TelemetryQuotaDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export type TelemetryQuotaConsumer = (
  digest: string,
) => Promise<TelemetryQuotaDecision>;

export type TelemetryQuotaSqlExecutor = (
  statement: SQL,
) => Promise<unknown>;

export class TelemetryQuotaUnavailable extends Error {
  constructor() {
    super('Telemetry quota service unavailable');
    this.name = 'TelemetryQuotaUnavailable';
  }
}

/**
 * Require a canonical 32-byte base64url key.
 *
 * Use a separate secret from enrollment and invitation
 * rate limiting.
 */
export function parseTelemetryQuotaKey(
  value: unknown,
): Buffer {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value)
  ) {
    throw new TelemetryQuotaUnavailable();
  }

  const bytes = Buffer.from(value, 'base64url');

  if (
    bytes.length !== 32 ||
    bytes.toString('base64url') !== value
  ) {
    throw new TelemetryQuotaUnavailable();
  }

  return bytes;
}

function validateDecision(
  value: unknown,
): TelemetryQuotaDecision {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new TelemetryQuotaUnavailable();
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.allowed !== 'boolean' ||
    typeof record.retryAfterSeconds !== 'number' ||
    !Number.isSafeInteger(record.retryAfterSeconds) ||
    record.retryAfterSeconds < 0 ||
    record.retryAfterSeconds > 900 ||
    (
      record.allowed === true &&
      record.retryAfterSeconds !== 0
    ) ||
    (
      record.allowed === false &&
      record.retryAfterSeconds === 0
    )
  ) {
    throw new TelemetryQuotaUnavailable();
  }

  return {
    allowed: record.allowed,
    retryAfterSeconds: record.retryAfterSeconds,
  };
}

/**
 * Generates an opaque, stable HMAC identity from a verified
 * network address.
 *
 * The raw address is never sent to the SQL quota consumer.
 */
export function createTelemetryNetworkQuotaLimiter(
  options: {
    hmacKey: string;
    consume: TelemetryQuotaConsumer;
  },
) {
  if (
    !options ||
    typeof options.consume !== 'function'
  ) {
    throw new TelemetryQuotaUnavailable();
  }

  const key = parseTelemetryQuotaKey(options.hmacKey);

  return {
    async checkNetwork(address: unknown): Promise<void> {
      let canonical: string;

      try {
        canonical = canonicalClientAddress(address);
      } catch {
        throw new TelemetryQuotaUnavailable();
      }

      const digest = createHmac('sha256', key)
        .update(
          `pulse-telemetry-network-v1\0submit\0${canonical}`,
        )
        .digest('hex');

      let decision: TelemetryQuotaDecision;

      try {
        decision = validateDecision(
          await options.consume(digest),
        );
      } catch {
        throw new TelemetryQuotaUnavailable();
      }

      if (!decision.allowed) {
        throw new TelemetryIngressRateLimited(
          decision.retryAfterSeconds,
        );
      }
    },
  };
}

/**
 * Review-only SQL adapter.
 *
 * The future database migration must implement the fixed
 * function with atomic counters and least-privilege grants.
 *
 * No raw IP address, tenant ID, agent ID, or machine secret
 * is supplied to this SQL function.
 */
export function createPostgresTelemetryNetworkQuotaConsumer(
  execute: TelemetryQuotaSqlExecutor,
): TelemetryQuotaConsumer {
  if (typeof execute !== 'function') {
    throw new TelemetryQuotaUnavailable();
  }

  return async digest => {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new TelemetryQuotaUnavailable();
    }

    let result: unknown;

    try {
      result = await execute(sql`
        SELECT allowed, retry_after_seconds
        FROM pulse_telemetry_quota.consume_network_quota(
          ${digest}::text
        )
      `);
    } catch {
      throw new TelemetryQuotaUnavailable();
    }

    if (
      !result ||
      typeof result !== 'object' ||
      !('rows' in result) ||
      !Array.isArray(result.rows) ||
      result.rows.length !== 1
    ) {
      throw new TelemetryQuotaUnavailable();
    }

    const row: unknown = result.rows[0];

    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row)
    ) {
      throw new TelemetryQuotaUnavailable();
    }

    const record = row as Record<string, unknown>;

    return validateDecision({
      allowed: record.allowed,
      retryAfterSeconds: record.retry_after_seconds,
    });
  };
}
