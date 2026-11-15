/** D15C-5Q — authenticated GET-only local preview of tenant-owned agents. */
import type { RequestHandler } from 'express';
import type { AuthenticatedIdentity } from '../auth/workos-auth.js';
import {
  listAgentsForIdentity, AgentListAccessDeniedError,
} from './agent-list-service.js';
import {
  isAgentUuid, parseAgentListResponse, type AgentListResponse,
} from './agent-list-contract.js';

export type AgentListLoader = (
  identity: AuthenticatedIdentity, organizationId: string,
) => Promise<AgentListResponse>;

function identityFromMiddleware(value: unknown): AuthenticatedIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Partial<AuthenticatedIdentity>;
  return identity.provider === 'workos' &&
    typeof identity.subject === 'string' && identity.subject.length <= 255 &&
    /^user_[A-Za-z0-9_-]+$/.test(identity.subject) &&
    typeof identity.sessionId === 'string' && identity.sessionId.length > 0
    ? identity as AuthenticatedIdentity : null;
}

export function createAgentListRoute(
  loader: AgentListLoader = listAgentsForIdentity,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = identityFromMiddleware(res.locals.authenticatedIdentity);
    if (!identity) { res.status(401).json({ error: 'authentication_required' }); return; }
    if (!isAgentUuid(req.params.organizationId) || Object.keys(req.query).length !== 0) {
      res.status(400).json({ error: 'invalid_agent_list_request' }); return;
    }
    try {
      const result = await loader(identity, req.params.organizationId);
      if (!parseAgentListResponse(result, req.params.organizationId)) {
        throw new Error('Invalid agent-list result');
      }
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof AgentListAccessDeniedError) {
        res.status(403).json({ error: 'organization_access_denied' }); return;
      }
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'agent_list_unavailable' });
    }
  };
}
