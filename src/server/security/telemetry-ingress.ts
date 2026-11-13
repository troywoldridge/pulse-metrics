/**
 * Pulse Metrics — D15C-2 isolated telemetry ingress candidate.
 *
 * UNMOUNTED. NOT APPROVED FOR PRODUCTION.
 *
 * Verify network transport, reject prohibited request encoding
 * and declared body sizes, then perform independent network quota.
 *
 * A trusted reverse proxy must overwrite forwarding headers and
 * prevent direct connections to the application backend.
 *
 * This does not authenticate machine credentials. The protected
 * PostgreSQL ingestion function performs machine authorization.
 */

import type {
  Request,
  RequestHandler,
  Response,
} from 'express';

import {
  canonicalClientAddress,
  resolveTrustedProxyClientAddress,
  type TrustedProxyPolicy,
} from './trusted-client-address.js';

import {
  MAX_INGESTION_BYTES,
} from '../telemetry/normalize-ingestion.js';

export type TelemetryIngressMode =
  | 'direct-tls'
  | 'trusted-proxy';

export type TelemetryNetworkQuotaCheck = (
  canonicalAddress: string,
) => Promise<void>;

export class TelemetryIngressRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Telemetry ingress quota exceeded');
    this.name = 'TelemetryIngressRateLimited';
  }
}

export interface TelemetryIngressOptions {
  mode: TelemetryIngressMode;
  trustedProxies?: TrustedProxyPolicy | null;
  checkNetwork: TelemetryNetworkQuotaCheck | null;
  isolatedTestOnly: boolean;
  production: boolean;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function singleHeader(
  req: Request,
  name: string,
): string | null {
  const raw = req.rawHeaders;

  if (!Array.isArray(raw) || raw.length % 2 !== 0) {
    return null;
  }

  let count = 0;

  for (let i = 0; i < raw.length; i += 2) {
    if (
      typeof raw[i] === 'string' &&
      raw[i].toLowerCase() === name
    ) {
      count++;
    }
  }

  const value = req.headers[name];

  return count === 1 && typeof value === 'string'
    ? value
    : null;
}

function verifiedAddress(
  req: Request,
  options: TelemetryIngressOptions,
): string {
  if (options.mode === 'direct-tls') {
    const socket = req.socket as typeof req.socket & {
      encrypted?: boolean;
    };

    if (socket.encrypted !== true) {
      throw new Error('Verified TLS required');
    }

    return canonicalClientAddress(
      req.socket.remoteAddress,
    );
  }

  if (
    options.mode === 'trusted-proxy' &&
    options.trustedProxies
  ) {
    const address = resolveTrustedProxyClientAddress(
      req,
      options.trustedProxies,
    );

    if (
      singleHeader(req, 'x-forwarded-proto') !== 'https'
    ) {
      throw new Error('Verified proxy TLS required');
    }

    return address;
  }

  throw new Error('Unconfigured telemetry transport');
}

type PreflightResult =
  | { status: 413; error: 'telemetry_payload_too_large' }
  | { status: 415; error: 'unsupported_telemetry_media' }
  | null;

/**
 * Only inspect request metadata here. Never read the request body.
 *
 * The body parser remains responsible for enforcing the byte
 * limit on streamed/chunked requests with no Content-Length.
 */
function preflight(
  req: Request,
): PreflightResult {
  // Reject any compressed request, including gzip and deflate.
  // Do not allow Express to inflate it before rejection.
  if (req.headers['content-encoding'] !== undefined) {
    return {
      status: 415,
      error: 'unsupported_telemetry_media',
    };
  }

  // Reject ambiguous or malformed Content-Length metadata.
  const rawLength = req.rawHeaders.filter(
    (_value, index) =>
      index % 2 === 0 &&
      req.rawHeaders[index].toLowerCase() === 'content-length',
  );

  if (rawLength.length > 1) {
    return {
      status: 413,
      error: 'telemetry_payload_too_large',
    };
  }

  if (rawLength.length === 0) {
    return null;
  }

  const value = singleHeader(req, 'content-length');

  if (
    value === null ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    return {
      status: 413,
      error: 'telemetry_payload_too_large',
    };
  }

  const size = Number(value);

  if (
    !Number.isSafeInteger(size) ||
    size > MAX_INGESTION_BYTES
  ) {
    return {
      status: 413,
      error: 'telemetry_payload_too_large',
    };
  }

  return null;
}

function reject(
  res: Response,
  error: unknown,
): void {
  noStore(res);

  if (
    error instanceof TelemetryIngressRateLimited &&
    Number.isSafeInteger(error.retryAfterSeconds) &&
    error.retryAfterSeconds >= 1 &&
    error.retryAfterSeconds <= 900
  ) {
    res.setHeader(
      'Retry-After',
      String(error.retryAfterSeconds),
    );

    res.status(429).json({
      error: 'telemetry_rate_limited',
    });
    return;
  }

  res.setHeader('Retry-After', '5');
  res.status(503).json({
    error: 'telemetry_ingress_unavailable',
  });
}

/**
 * Mount before JSON parsing, authentication and persistence.
 *
 * This candidate rejects production activation.
 */
export function createIsolatedTelemetryIngressGuard(
  options: TelemetryIngressOptions,
): RequestHandler {
  const ready = (): boolean =>
    options?.isolatedTestOnly === true &&
    options.production === false &&
    process.env.NODE_ENV !== 'production' &&
    typeof options.checkNetwork === 'function' &&
    (
      options.mode === 'direct-tls' ||
      (
        options.mode === 'trusted-proxy' &&
        options.trustedProxies !== null &&
        options.trustedProxies !== undefined
      )
    );

  return async (req, res, next) => {
    noStore(res);

    if (!ready()) {
      reject(res, null);
      return;
    }

    try {
      // Verify the network boundary before trusting metadata
      // or performing quota operations.
      const address = verifiedAddress(req, options);

      const rejected = preflight(req);

      if (rejected) {
        res.status(rejected.status).json({
          error: rejected.error,
        });
        return;
      }

      await options.checkNetwork!(address);

      next();
    } catch (error) {
      reject(res, error);
    }
  };
}
