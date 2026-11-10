import type { RequestHandler } from 'express';
import {
  acceptInvitationForIdentity,
  InvitationNotAvailableError,
  InvitationAcceptanceUnavailableError,
  isCanonicalInvitationToken,
  type InvitationAcceptanceResult,
} from './invitation-acceptance-service.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export type InvitationAcceptor = (
  identity: AuthenticatedIdentity,
  rawToken: string,
) => Promise<InvitationAcceptanceResult>;

const SUBJECT = /^user_[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authenticatedIdentity(value: unknown): AuthenticatedIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<AuthenticatedIdentity>;
  return item.provider === 'workos' &&
    typeof item.subject === 'string' && item.subject.length <= 255 &&
    SUBJECT.test(item.subject) && typeof item.sessionId === 'string' &&
    item.sessionId.length > 0 ? item as AuthenticatedIdentity : null;
}

export function parseInvitationAcceptanceBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'token' ||
      !isCanonicalInvitationToken(value.token)) return null;
  return value.token;
}

/**
 * Intended future POST /api/invitations/accept.
 * Intentionally NOT mounted in server.ts. Requires rate limiting, real WorkOS
 * verification and database-backed HTTP tests before activation.
 * Request body accepts ONLY the raw invitation secret, never identity/email,
 * organization or role. No secrets are logged or included in error responses.
 */
export function createInvitationAcceptanceRoute(
  accept: InvitationAcceptor = acceptInvitationForIdentity,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = authenticatedIdentity(res.locals.authenticatedIdentity);
    if (!identity) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'json_required' });
      return;
    }
    const token = parseInvitationAcceptanceBody(req.body);
    if (!token) {
      res.status(400).json({ error: 'invalid_invitation_request' });
      return;
    }
    try {
      const result = await accept(identity, token);
      if (!result || !UUID.test(result.organizationId) ||
          !['admin', 'member', 'viewer'].includes(result.membershipRole)) {
        throw new InvitationAcceptanceUnavailableError();
      }
      res.status(200).json({
        organizationId: result.organizationId,
        membershipRole: result.membershipRole,
      });
    } catch (error) {
      if (error instanceof InvitationNotAvailableError) {
        // Same error for wrong email, unknown/used/expired/revoked token and
        // existing membership. Never reveal which of those conditions applied.
        res.status(404).json({ error: 'invitation_unavailable' });
        return;
      }
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'invitation_acceptance_unavailable' });
    }
  };
}
