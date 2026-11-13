/**
 * Pulse Metrics — D15C isolated HTTP ingestion candidate.
 *
 * UNMOUNTED. NOT APPROVED FOR PRODUCTION.
 *
 * Admission is for isolated tests only, not proof of TLS,
 * rate limiting, or authenticated network ingress.
 *
 * Organization and agent identity must be derived by the
 * protected PostgreSQL function from the machine credential.
 */

import type {
  Request,
  RequestHandler,
  Response,
} from 'express';

import {
  InvalidMachineCredentialError,
  TelemetryPersistenceUnavailable,
  TelemetrySubmissionConflict,
  type TelemetryPersistenceOutcome,
} from './postgres-ingestion.js';

import {
  InvalidSubmissionIdentityError,
} from './submission-identity.js';

import {
  InvalidTelemetryError,
  MAX_INGESTION_BYTES,
} from './normalize-ingestion.js';

export type TelemetryHttpIngest = (
  secret: unknown,
  submissionId: unknown,
  envelope: unknown,
) => Promise<TelemetryPersistenceOutcome>;

interface CandidateOptions {
  ingest: TelemetryHttpIngest;
  isolatedTestOnly: boolean;
  production: boolean;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function oneHeader(
  req: Request,
  name: string,
): string | null {
  const headers = req.rawHeaders;

  if (
    !Array.isArray(headers) ||
    headers.length % 2 !== 0
  ) {
    return null;
  }

  let count = 0;

  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index].toLowerCase() === name) {
      count++;
    }
  }

  const value = req.headers[name];

  return count === 1 && typeof value === 'string'
    ? value
    : null;
}

function parseMachineBearer(
  req: Request,
): string | null {
  const authorization = oneHeader(
    req,
    'authorization',
  );

  if (!authorization) {
    return null;
  }

  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    authorization,
  );

  return match ? match[1] : null;
}

function parseSubmission(body: unknown): {
  submissionId: unknown;
  envelope: unknown;
} | null {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return null;
  }

  const keys = Object.keys(record);

  if (
    keys.length !== 2 ||
    !keys.includes('submissionId') ||
    !keys.includes('envelope')
  ) {
    return null;
  }

  return {
    submissionId: record.submissionId,
    envelope: record.envelope,
  };
}

/**
 * Candidate handler is deliberately fail-closed unless an
 * explicitly enabled isolated-test admission handler precedes it.
 *
 * This admission handler MUST NOT be used as a production
 * network security boundary.
 */
export function createIsolatedTelemetryHttpCandidate(
  options: CandidateOptions,
): {
  admitIsolatedTestRequest: RequestHandler;
  handler: RequestHandler;
} {
  if (typeof options?.ingest !== 'function') {
    throw new TypeError(
      'Explicit telemetry ingestion dependency required',
    );
  }

  const admitted = new WeakSet<Response>();

  const ready = (): boolean =>
    options.isolatedTestOnly === true &&
    options.production === false &&
    process.env.NODE_ENV !== 'production';

  const unavailable = (res: Response): void => {
    res.status(503).json({
      error: 'telemetry_ingress_unavailable',
    });
  };

  const admitIsolatedTestRequest: RequestHandler = (
    _req,
    res,
    next,
  ) => {
    noStore(res);

    if (!ready()) {
      unavailable(res);
      return;
    }

    admitted.add(res);
    next();
  };

  const handler: RequestHandler = async (
    req,
    res,
  ) => {
    noStore(res);

    if (!ready() || !admitted.delete(res)) {
      unavailable(res);
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({
        error: 'method_not_allowed',
      });
      return;
    }

    const credential = parseMachineBearer(req);

    if (!credential) {
      res.status(401).json({
        error: 'invalid_machine_credential',
      });
      return;
    }

    const contentType = oneHeader(
      req,
      'content-type',
    );

    if (
      !contentType ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
        contentType,
      ) ||
      req.headers['content-encoding'] !== undefined
    ) {
      res.status(415).json({
        error: 'unsupported_telemetry_media',
      });
      return;
    }

    const contentLength = oneHeader(
      req,
      'content-length',
    );

    if (contentLength !== null) {
      const size = Number(contentLength);

      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_INGESTION_BYTES
      ) {
        res.status(413).json({
          error: 'telemetry_payload_too_large',
        });
        return;
      }
    }

    const submission = parseSubmission(req.body);

    if (!submission) {
      res.status(400).json({
        error: 'invalid_telemetry_submission',
      });
      return;
    }

    try {
      const outcome = await options.ingest(
        credential,
        submission.submissionId,
        submission.envelope,
      );

      if (
        outcome !== 'inserted' &&
        outcome !== 'duplicate'
      ) {
        throw new TelemetryPersistenceUnavailable();
      }

      res.status(
        outcome === 'inserted' ? 202 : 200,
      ).json({
        status: outcome,
      });
    } catch (error) {
      if (
        error instanceof InvalidMachineCredentialError
      ) {
        res.status(401).json({
          error: 'invalid_machine_credential',
        });
        return;
      }

      if (
        error instanceof InvalidTelemetryError ||
        error instanceof InvalidSubmissionIdentityError
      ) {
        res.status(400).json({
          error: 'invalid_telemetry_submission',
        });
        return;
      }

      if (error instanceof TelemetrySubmissionConflict) {
        res.status(409).json({
          error: 'telemetry_submission_conflict',
        });
        return;
      }

      res.status(503).json({
        error: 'telemetry_ingestion_unavailable',
      });
    }
  };

  return {
    admitIsolatedTestRequest,
    handler,
  };
}
