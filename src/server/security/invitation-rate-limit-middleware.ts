import type { RequestHandler, Response } from 'express';
import type { AuthenticatedIdentity } from '../auth/workos-auth.js';
import {
  createLiveInvitationRateLimiter,
  InvitationRateLimitExceededError,
  type InvitationAction,
} from './invitation-rate-limit.js';
import {
  parseTrustedProxyCidrs,
  resolveTrustedProxyClientAddress,
  type TrustedProxyPolicy,
} from './trusted-client-address.js';

/** Network guard before WorkOS JWT; actor guard after verified WorkOS JWT. */
export type InvitationRateLimitChecks = Pick<
  ReturnType<typeof createLiveInvitationRateLimiter>,
  'checkNetwork' | 'checkActor'
>;

export type InvitationNetworkMode = 'local-direct-socket' | 'trusted-proxy' | 'disabled';
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

/** Production remains blocked until ingress and live WorkOS are verified.
 * The trusted-proxy mode is exercised in local tests but is NOT a public
 * activation switch. `req.ip` and unverified proxy headers are never used. */
export function createInvitationRateLimitGuards(options: {
  checks: InvitationRateLimitChecks | null;
  networkMode: InvitationNetworkMode;
  production: boolean;
  trustedProxies?: TrustedProxyPolicy | null;
}) {
  const { checks, networkMode, production, trustedProxies } = options;
  const ready = () => !!checks && !production &&
    (networkMode === 'local-direct-socket' ||
      (networkMode === 'trusted-proxy' && !!trustedProxies));

  function network(action: InvitationAction): RequestHandler {
    return async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!ready() || !checks) { fail(res, null); return; }
      try {
        const address = networkMode === 'trusted-proxy'
          ? resolveTrustedProxyClientAddress(req, trustedProxies!)
          : req.socket.remoteAddress;
        await checks.checkNetwork(action, address);
        next();
      } catch (error) { fail(res, error); }
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
      if (!ready() || !checks) { fail(res, null); return; }
      try {
        await checks.checkActor(action, identity);
        next();
      } catch (error) { fail(res, error); }
    };
  }
  return { network, actor };
}

/** Configuration failure affects only invitation operations, not health. */
export function createLiveInvitationRateLimitGuards(
  environment: NodeJS.ProcessEnv = process.env,
) {
  let checks: InvitationRateLimitChecks | null = null;
  let trustedProxies: TrustedProxyPolicy | null = null;
  const mode = environment.INVITATION_RATE_LIMIT_NETWORK_MODE;
  try {
    checks = createLiveInvitationRateLimiter(environment);
    if (mode === 'trusted-proxy') {
      trustedProxies = parseTrustedProxyCidrs(environment.INVITATION_TRUSTED_PROXY_CIDRS);
    }
  } catch {
    checks = null;
    trustedProxies = null;
  }
  const networkMode: InvitationNetworkMode =
    mode === 'local-direct-socket' || mode === 'trusted-proxy' ? mode : 'disabled';
  return createInvitationRateLimitGuards({
    checks, trustedProxies, networkMode,
    production: environment.NODE_ENV === 'production',
  });
}
