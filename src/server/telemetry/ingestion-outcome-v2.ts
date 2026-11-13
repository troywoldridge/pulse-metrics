/**
 * Pulse Metrics D15C-4A — review-only database outcome contract.
 *
 * UNMOUNTED. NOT APPROVED FOR PRODUCTION.
 *
 * PostgreSQL returns a single scalar text outcome. D15C-4E explicitly
 * distinguishes credential_unavailable from a transport/SQL permission
 * error. Never guess from a generic PostgreSQL SQLSTATE.
 *
 * This module does not connect to PostgreSQL, authorize credentials,
 * install database functions, or expose an HTTP route.
 */

export type IngestionDecisionV2 =
  | { readonly outcome: 'inserted'; readonly retryAfterSeconds: 0 }
  | { readonly outcome: 'duplicate'; readonly retryAfterSeconds: 0 }
  | { readonly outcome: 'conflict'; readonly retryAfterSeconds: 0 }
  | { readonly outcome: 'credential_unavailable'; readonly retryAfterSeconds: 0 }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

export class InvalidIngestionDecisionV2 extends Error {
  constructor() {
    super('Invalid telemetry ingestion database outcome');
    this.name = 'InvalidIngestionDecisionV2';
  }
}

/**
 * Parse a result ONLY after the SQL executor has checked that exactly
 * one row with a single outcome value was returned.
 *
 * No coercions, whitespace trimming, prefixes, leading zeroes,
 * fractional durations, extra fields, or unexpected values allowed.
 * Caller must treat this exception as a sanitized 503, never success.
 */
export function parseIngestionDecisionV2(value: unknown): IngestionDecisionV2 {
  if (value === 'inserted') {
    return { outcome: 'inserted', retryAfterSeconds: 0 };
  }

  if (value === 'duplicate') {
    return { outcome: 'duplicate', retryAfterSeconds: 0 };
  }

  if (value === 'conflict') {
    return { outcome: 'conflict', retryAfterSeconds: 0 };
  }

  if (value === 'credential_unavailable') {
    return { outcome: 'credential_unavailable', retryAfterSeconds: 0 };
  }

  if (typeof value !== 'string') {
    throw new InvalidIngestionDecisionV2();
  }

  const match = /^rate_limited:([1-9][0-9]{0,2})$/.exec(value);
  if (!match) {
    throw new InvalidIngestionDecisionV2();
  }

  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds > 900) {
    throw new InvalidIngestionDecisionV2();
  }

  return { outcome: 'rate_limited', retryAfterSeconds: seconds };
}
