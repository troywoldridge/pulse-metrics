import type { RequestHandler } from 'express';
import { resolveAuthenticatedUserId } from './identity-provisioning.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export type IdentityResolver = (identity: AuthenticatedIdentity) => Promise<string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isVerifiedIdentity(value: unknown): value is AuthenticatedIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<AuthenticatedIdentity>;
  return identity.provider === 'workos' &&
    typeof identity.subject === 'string' &&
    /^user_[A-Za-z0-9_-]+$/.test(identity.subject) &&
    identity.subject.length <= 255 &&
    typeof identity.sessionId === 'string' &&
    identity.sessionId.length > 0;
}

/**
 * Returns only the caller's local identity, never their organization access.
 * Mount AFTER requireWorkOSUser. Without that middleware, this fails closed.
 */
export function createIdentityRoute(
  resolveUserId: IdentityResolver = resolveAuthenticatedUserId,
): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity: unknown = res.locals.authenticatedIdentity;

    if (!isVerifiedIdentity(identity)) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    try {
      const userId = await resolveUserId(identity);
      if (!UUID.test(userId)) {
        throw new Error('Invalid user identifier from identity resolver.');
      }
      res.json({
        provider: identity.provider,
        subject: identity.subject,
        userId,
      });
    } catch {
      // Avoid exposing database errors, SQL, identity subjects or credentials.
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'identity_provisioning_unavailable' });
    }
  };
}
