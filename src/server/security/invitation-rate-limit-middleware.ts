import type { RequestHandler, Response } from 'express';
import type { AuthenticatedIdentity } from '../auth/workos-auth.js';
import {
  createLiveInvitationRateLimiter,
  InvitationRateLimitExceededError,
  type InvitationAction,
} from './invitation-rate-limit.js';

/**
 * Phase 2E3C4B3: local-only HTTP integration for the shared PostgreSQL limiter.
 * The network guard MUST run before bearer verification. The actor guard MUST
 * run after requireWorkOSUser() and uses ONLY res.locals.authenticatedIdentity.
 * Neither IP headers nor a browser-supplied user or invitation token is a key.
 *
 * DO NOT activate an Internet-facing endpoint with direct socket mode: a
 * reverse proxy would cause all users to share its IP. Production deliberately
 * fails closed until an independently reviewed trusted-proxy resolver exists.
 */
export type InvitationRateLimitChecks = Pick<
  ReturnType<typeof createLiveInvitationRateLimiter>,
  'checkNetwork' | 'checkActor'
>;

export type InvitationNetworkMode = 'local-direct-socket' | 'disabled';

const SUBJECT = /^user_[A-Za-z0-9_-]+$/;

function isAuthenticatedIdentity(value: unknown): value is AuthenticatedIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AuthenticatedIdentity>;
  return item.provider === 'workos' &&
    typeof item.subject === 'string' && item.subject.length <= 255 &&
    SUBJECT.test(item.subject) &&
    typeof item.sessionId === 'string' && item.sessionId.length > 0;
}

function fail(res: Response, error: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  if (error instanceof InvitationRateLimitExceededError &&
      Number.isSafeInteger(error.retryAfterSeconds) &&
      error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 900) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
    res.status(429).json({ error: 'invitation_rate_limited' });
    return;
  }
  res.setHeader('Retry-After', '5');
  res.status(503).json({ error: 'invitation_rate_limit_unavailable' });
}

export function createInvitationRateLimitGuards(options: {
  checks: InvitationRateLimitChecks | null;
  networkMode: InvitationNetworkMode;
  production: boolean;
}) {
  const { checks, networkMode, production } = options;
  function network(action: InvitationAction): RequestHandler {
    return async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      // No safe proxy-chain resolver yet. Don't accept even an explicit
      // local-direct-socket setting in production.
      if (production || networkMode !== 'local-direct-socket' || !checks) {
        fail(res, null);
        return;
      }
      try {
        // Never consult req.ip, X-Forwarded-For, Forwarded or X-Real-IP.
        await checks.checkNetwork(action, req.socket.remoteAddress);
        next();
      } catch (error) {
        fail(res, error);
      }
    };
  }
  function actor(action: InvitationAction): RequestHandler {
    return async (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      const identity = res.locals.authenticatedIdentity as unknown;
      if (!isAuthenticatedIdentity(identity)) {
        res.status(401).json({ error: 'authentication_required' });
        return;
      }
      if (!checks || production || networkMode !== 'local-direct-socket') {
        fail(res, null);
        return;
      }
      try {
        await checks.checkActor(action, identity);
        next();
      } catch (error) {
        fail(res, error);
      }
    };
  }
  return { network, actor };
}

/** Missing/invalid secrets or unsupported network mode disable invitations,
 * not health or other unrelated APIs. No secret is included in any error. */
export function createLiveInvitationRateLimitGuards(
  environment: NodeJS.ProcessEnv = process.env,
) {
  let checks: InvitationRateLimitChecks | null = null;
  try {
    checks = createLiveInvitationRateLimiter(environment);
  } catch {
    // Intentionally fail closed for protected routes, not the health endpoint.
  }
  return createInvitationRateLimitGuards({
    checks,
    networkMode: environment.INVITATION_RATE_LIMIT_NETWORK_MODE === 'local-direct-socket'
      ? 'local-direct-socket' : 'disabled',
    production: environment.NODE_ENV === 'production',
  });
}
