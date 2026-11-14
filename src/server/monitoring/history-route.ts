/**
 * D15C-5L — authenticated historical-read HTTP handler candidate.
 * NOT mounted in server.ts. Never change the existing 503 monitoring hold.
 * Requires the established requireWorkOSUser middleware before registration,
 * AND separate database/cross-tenant integration review prior to any mount.
 */
import type { RequestHandler } from 'express';
import type { AuthenticatedIdentity } from '../auth/workos-auth.js';
import { readHistoryForIdentity, HistoryAccessDeniedError, HistoryAgentNotFoundError } from './history-service.js';
import {
  InvalidHistoryRequestError, parseHistoryRequest, validHistoryResponse,
  type HistoryRequest, type HistoryResponse,
} from './history-contract.js';

export type HistoryLoader = (
  identity: AuthenticatedIdentity,
  request: HistoryRequest,
) => Promise<HistoryResponse>;

/** Middleware independently rejects a missing/invalid established identity. */
function verifiedIdentity(value: unknown): AuthenticatedIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AuthenticatedIdentity>;
  return candidate.provider === 'workos' &&
    typeof candidate.subject === 'string' &&
    candidate.subject.length <= 255 &&
    /^user_[A-Za-z0-9_-]+$/.test(candidate.subject) &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0
    ? candidate as AuthenticatedIdentity : null;
}

export function createHistoryRoute(
  load: HistoryLoader = readHistoryForIdentity,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = verifiedIdentity(res.locals.authenticatedIdentity);
    if (!identity) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    let request: HistoryRequest;
    try {
      request = parseHistoryRequest(
        req.params.organizationId, req.params.agentId, req.query,
      );
    } catch (error) {
      if (!(error instanceof InvalidHistoryRequestError)) {
        res.status(503).json({ error: 'history_unavailable' });
        return;
      }
      res.status(400).json({ error: 'invalid_history_request' });
      return;
    }

    try {
      const result = await load(identity, request);
      if (!validHistoryResponse(result, request)) {
        throw new Error('Invalid history adapter result');
      }
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof HistoryAccessDeniedError) {
        res.status(403).json({ error: 'organization_access_denied' });
        return;
      }
      if (error instanceof HistoryAgentNotFoundError) {
        res.status(404).json({ error: 'agent_not_found' });
        return;
      }
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'history_unavailable' });
    }
  };
}
