/**
 * Pulse Metrics — D15C-5R isolated HTTPS telemetry sender candidate.
 *
 * NOT WIRED TO THE AGENT RUNNER OR SERVER. NOT APPROVED FOR PRODUCTION.
 * No credential-file access, database access, retries, polling, or route mounts.
 * The caller must independently verify machine enrollment, configure the
 * destination from trusted operator settings, and supply a TLS-verifying fetch.
 *
 * IMPORTANT: /api/agent-telemetry/v1 is a PROPOSED path. The actual ingress
 * route must be reviewed and agreed before any real network activation.
 */
import { Buffer } from 'node:buffer';
import { validateTelemetryEnvelope } from '../telemetry-contract.js';

export const PROPOSED_TELEMETRY_PATH = '/api/agent-telemetry/v1';
const MAX_REQUEST_BYTES = 16 * 1024; // Conservative candidate bound; reconcile with server before activation.
const MAX_RESPONSE_BYTES = 2048;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type TelemetryDeliveryOutcome = 'inserted' | 'duplicate';
export type TelemetryDeliveryFailureCode =
  | 'invalid_request'
  | 'credential_rejected'
  | 'submission_rejected'
  | 'submission_conflict'
  | 'rate_limited'
  | 'unavailable';

const SAFE_FAILURE_MESSAGES: Record<TelemetryDeliveryFailureCode, string> = {
  invalid_request: 'Telemetry request rejected locally',
  credential_rejected: 'Machine credential rejected',
  submission_rejected: 'Telemetry submission rejected',
  submission_conflict: 'Telemetry submission conflict',
  rate_limited: 'Telemetry delivery rate limited',
  unavailable: 'Telemetry delivery unavailable',
};

export class TelemetryDeliveryError extends Error {
  readonly code: TelemetryDeliveryFailureCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: TelemetryDeliveryFailureCode, retryAfterSeconds: number | null = null) {
    super(SAFE_FAILURE_MESSAGES[code]);
    this.name = 'TelemetryDeliveryError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Accept globalThis.fetch, or a deliberately injected in-memory test double. */
export type TelemetryFetch = (url: string, options: RequestInit) => Promise<Response>;

export interface HttpsSenderOptions {
  /** Exactly an HTTPS origin, e.g. https://monitor.example.com (no path or credentials). */
  readonly origin: string;
  /** Explicit transport dependency. Never disable certificate or hostname verification. */
  readonly fetchImpl: TelemetryFetch;
  readonly timeoutMs?: number;
}

export interface TelemetrySubmission {
  readonly machineCredential: unknown;
  readonly submissionId: unknown;
  readonly envelope: unknown;
}

function invalid(): never {
  throw new TelemetryDeliveryError('invalid_request');
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const names = Object.keys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    names.every(key => required.includes(key) || optional.includes(key));
}

function canonicalTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !CANONICAL_ISO.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function checkedEnvelope(envelope: unknown): string {
  if (!validateTelemetryEnvelope(envelope) ||
      !exactKeys(envelope, ['schemaVersion', 'sentAt', 'samples']) ||
      !canonicalTimestamp(envelope.sentAt) || envelope.samples.length === 0) invalid();

  const seen = new Set<string>();
  for (const sample of envelope.samples) {
    if (!exactKeys(sample, ['metric', 'value', 'unit', 'observedAt', 'status'], ['source', 'reason']) ||
        !canonicalTimestamp(sample.observedAt) || seen.has(sample.metric) ||
        (sample.source !== undefined && (typeof sample.source !== 'string' || sample.source.length > 256)) ||
        (sample.reason !== undefined && (typeof sample.reason !== 'string' || sample.reason.length > 256)) ||
        (sample.metric === 'cpu.usage_percent' && sample.value !== null && sample.value > 100)) invalid();
    seen.add(sample.metric);
  }

  let body: string;
  try { body = JSON.stringify(envelope); } catch { invalid(); }
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) invalid();
  return body;
}

function machineSecret(secret: unknown): string {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) invalid();
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) invalid();
  return secret;
}

function verifiedDestination(origin: unknown): string {
  if (typeof origin !== 'string') invalid();
  let parsed: URL;
  try { parsed = new URL(origin); } catch { invalid(); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/' || !parsed.hostname || parsed.hostname.endsWith('.')) invalid();
  return new URL(PROPOSED_TELEMETRY_PATH, parsed).toString();
}

function timeoutValue(value: unknown): number {
  if (value === undefined) return 10000;
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 30000) invalid();
  return value as number;
}

async function responseJson(response: Response): Promise<unknown> {
  const mediaType = response.headers.get('content-type');
  if (!mediaType || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(mediaType)) {
    throw new TelemetryDeliveryError('unavailable');
  }
  const cacheControl = response.headers.get('cache-control');
  if (!cacheControl || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) {
    throw new TelemetryDeliveryError('unavailable');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new TelemetryDeliveryError('unavailable');
  }
  if (!response.body) throw new TelemetryDeliveryError('unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new TelemetryDeliveryError('unavailable');
      chunks.push(part.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new TelemetryDeliveryError('unavailable');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new TelemetryDeliveryError('unavailable'); }
}

function isExactStatus(value: unknown, expected: string, key: 'status' | 'error'): boolean {
  return exactKeys(value, [key]) && (value as Record<string, unknown>)[key] === expected;
}

/** One HTTP attempt. NEVER retries or generates/replaces a submission UUID. */
export function createHttpsTelemetrySender(options: HttpsSenderOptions) {
  const url = verifiedDestination(options?.origin);
  if (typeof options.fetchImpl !== 'function') invalid();
  const timeoutMs = timeoutValue(options.timeoutMs);

  return {
    async send(submission: TelemetrySubmission): Promise<TelemetryDeliveryOutcome> {
      if (!exactKeys(submission, ['machineCredential', 'submissionId', 'envelope'])) invalid();
      const credential = machineSecret(submission.machineCredential);
      if (typeof submission.submissionId !== 'string' || !UUID_V4.test(submission.submissionId)) invalid();
      checkedEnvelope(submission.envelope);

      // Construct a brand-new strict two-property body; no organization/agent ID.
      const body = JSON.stringify({ submissionId: submission.submissionId, envelope: submission.envelope });
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) invalid();
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await options.fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-store',
          },
          credentials: 'omit',
          redirect: 'manual',
          referrerPolicy: 'no-referrer',
          body,
          signal: controller.signal,
        });
        // Timeout guards both response headers and bounded response body.
        const result = await responseJson(response);
        if (response.status === 202 && isExactStatus(result, 'inserted', 'status')) return 'inserted';
        if (response.status === 200 && isExactStatus(result, 'duplicate', 'status')) return 'duplicate';
        if (response.status === 401 && isExactStatus(result, 'invalid_machine_credential', 'error')) {
          throw new TelemetryDeliveryError('credential_rejected');
        }
        if (response.status === 400 && isExactStatus(result, 'invalid_telemetry_submission', 'error') ||
            response.status === 413 && isExactStatus(result, 'telemetry_payload_too_large', 'error') ||
            response.status === 415 && isExactStatus(result, 'unsupported_telemetry_media', 'error')) {
          throw new TelemetryDeliveryError('submission_rejected');
        }
        if (response.status === 409 && isExactStatus(result, 'telemetry_submission_conflict', 'error')) {
          throw new TelemetryDeliveryError('submission_conflict');
        }
        if (response.status === 429 && isExactStatus(result, 'telemetry_rate_limited', 'error')) {
          const retry = response.headers.get('retry-after');
          if (retry && /^(?:[1-9]\d{0,2})$/.test(retry) && Number(retry) <= 900) {
            throw new TelemetryDeliveryError('rate_limited', Number(retry));
          }
        }
        throw new TelemetryDeliveryError('unavailable');
      } catch (error) {
        // Never allow a provider/socket exception to expose a credential or URL.
        if (error instanceof TelemetryDeliveryError) throw error;
        throw new TelemetryDeliveryError('unavailable');
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
