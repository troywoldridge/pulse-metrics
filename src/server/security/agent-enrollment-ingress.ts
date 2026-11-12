/**
 * Phase 2E3C5D10 — candidate, UNMOUNTED enrollment ingress boundary.
 * Refuses production activation and requires explicit isolated-test opt-in.
 * HTTPS evidence from an untrusted socket/header is NEVER authoritative.
 */
import type { RequestHandler, Response, Request } from 'express';
import {
  canonicalClientAddress, resolveTrustedProxyClientAddress,
  type TrustedProxyPolicy,
} from './trusted-client-address.js';
import { AgentQuotaExceeded, type createAgentQuotaLimiter } from './agent-enrollment-quota.js';
import { isVerifiedActor } from '../agent-credential-policy.js';

export type AgentIngressMode = 'direct-tls' | 'trusted-proxy';
export type AgentIngressLimiter = ReturnType<typeof createAgentQuotaLimiter>;

function reject(res: Response, error: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (error instanceof AgentQuotaExceeded &&
      Number.isSafeInteger(error.retryAfterSeconds) &&
      error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 900) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
    res.status(429).json({ error: 'agent_enrollment_rate_limited' });
  } else {
    res.setHeader('Retry-After', '5');
    res.status(503).json({ error: 'agent_enrollment_ingress_unavailable' });
  }
}

function oneHeader(req: Request, name: string): string | null {
  const raw = req.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return null;
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (typeof raw[i] === 'string' && raw[i].toLowerCase() === name) count++;
  }
  const value = req.headers[name];
  return count === 1 && typeof value === 'string' ? value : null;
}

function determineClientAddress(req: Request, mode: AgentIngressMode, proxies: TrustedProxyPolicy | null): string {
  if (mode === 'direct-tls') {
    // No forwarding headers count as proof of a TLS connection.
    if ((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted !== true) {
      throw new Error('TLS required');
    }
    return canonicalClientAddress(req.socket.remoteAddress);
  }
  if (mode === 'trusted-proxy' && proxies) {
    // The directly connected peer MUST be trusted, and that proxy MUST
    // independently overwrite X-Forwarded-Proto and X-Forwarded-For.
    const address = resolveTrustedProxyClientAddress(req, proxies);
    if (oneHeader(req, 'x-forwarded-proto') !== 'https') throw new Error('Verified proxy TLS required');
    return address;
  }
  throw new Error('Unconfigured ingress transport');
}

/**
 * Compose explicitly: issue -> network('issue'), REAL WorkOS middleware,
 * actor(), admit('issue'), issueRoute. Redeem -> network('redeem'),
 * admit('redeem'), redeemRoute. These handlers are NOT in server.ts.
 */
export function createAgentEnrollmentIngressGuards(options: {
  mode: AgentIngressMode;
  trustedProxies?: TrustedProxyPolicy | null;
  limiter: AgentIngressLimiter | null;
  isolatedTestOnly: boolean;
  production: boolean;
}) {
  const verified = new WeakMap<Response, { network: 'issue' | 'redeem'; actor: boolean }>();
  const ready = () => options?.isolatedTestOnly === true &&
    options.production === false && options.limiter !== null &&
    !!options.limiter &&
    (options.mode === 'direct-tls' || (options.mode === 'trusted-proxy' && !!options.trustedProxies));

  function network(action: 'issue' | 'redeem'): RequestHandler {
    return async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!ready() || (action !== 'issue' && action !== 'redeem')) {
        reject(res, null); return;
      }
      try {
        const address = determineClientAddress(req, options.mode, options.trustedProxies ?? null);
        await options.limiter!.checkNetwork(action, address);
        verified.set(res, { network: action, actor: false });
        next();
      } catch (error) { reject(res, error); }
    };
  }

  const actor: RequestHandler = async (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!ready() || verified.get(res)?.network !== 'issue') {
      reject(res, null); return;
    }
    if (!isVerifiedActor(res.locals.authenticatedIdentity)) {
      res.status(401).json({ error: 'authentication_required' }); return;
    }
    try {
      await options.limiter!.checkActor(res.locals.authenticatedIdentity);
      verified.get(res)!.actor = true;
      next();
    } catch (error) { reject(res, error); }
  };

  function admit(action: 'issue' | 'redeem'): RequestHandler {
    return (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!ready() || verified.get(res)?.network !== action ||
          (action === 'issue' && verified.get(res)?.actor !== true)) {
        reject(res, null); return;
      }
      // This remains a prelaunch compatibility marker for the D8 route
      // contract. It is written only after both private guards pass.
      res.locals.agentEnrollmentIngressVerified = true;
      next();
    };
  }
  return { network, actor, admit };
}
