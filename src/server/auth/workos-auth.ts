import { WorkOS } from '@workos-inc/node';
import { config as loadDotEnv } from 'dotenv';
import type { RequestHandler } from 'express';

// dotenv does not automatically read .env.local in a plain Node/tsx process.
// Existing process variables always win; secrets never enter the browser bundle.
loadDotEnv({ path: '.env', quiet: true });
loadDotEnv({ path: '.env.local', quiet: true });

export interface WorkOSAuthConfig {
  clientId: string;
  issuer: string;
  audience: string;
}

export interface VerifiedWorkOSClaims {
  sub: string;
  sid: string;
  iss: string;
  exp: number;
  [claim: string]: unknown;
}

export interface AuthenticatedIdentity {
  provider: 'workos';
  subject: string;
  sessionId: string;
}

export type TokenVerifier = (token: string) => Promise<VerifiedWorkOSClaims | null>;

export function readWorkOSAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkOSAuthConfig {
  const clientId = environment.WORKOS_CLIENT_ID?.trim();
  const issuer = environment.WORKOS_TOKEN_ISSUER?.trim();
  const audience = environment.WORKOS_TOKEN_AUDIENCE?.trim();

  if (!clientId || !clientId.startsWith('client_')) {
    throw new Error('WORKOS_CLIENT_ID must be a valid WorkOS application client ID.');
  }
  if (environment.VITE_WORKOS_CLIENT_ID &&
      environment.VITE_WORKOS_CLIENT_ID !== clientId) {
    throw new Error('WORKOS_CLIENT_ID and VITE_WORKOS_CLIENT_ID must match.');
  }
  if (!issuer) {
    throw new Error('WORKOS_TOKEN_ISSUER is required (the exact JWT iss claim).');
  }
  try {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid issuer');
    }
  } catch {
    throw new Error('WORKOS_TOKEN_ISSUER must be an HTTPS issuer URL.');
  }
  if (!audience) {
    throw new Error('WORKOS_TOKEN_AUDIENCE is required; configure the same aud in the WorkOS JWT template.');
  }
  if (audience.length > 512 || /\s/.test(audience)) {
    throw new Error('WORKOS_TOKEN_AUDIENCE must be a non-whitespace value of at most 512 characters.');
  }

  return { clientId, issuer, audience };
}

/** The SDK checks JWT signature, expiry, issuer and user-token classification.
 * This additional binding rejects tokens for other applications or APIs.
 */
export function tokenMatchesRecipient(
  claims: VerifiedWorkOSClaims,
  config: WorkOSAuthConfig,
): boolean {
  const audience = claims.aud;
  const correctAudience = audience === config.audience ||
    (Array.isArray(audience) && audience.includes(config.audience));

  return claims.iss === config.issuer &&
    claims.client_id === config.clientId &&
    correctAudience &&
    typeof claims.sub === 'string' && claims.sub.startsWith('user_') &&
    typeof claims.sid === 'string' && claims.sid.length > 0 &&
    typeof claims.exp === 'number' && Number.isFinite(claims.exp) &&
    claims.exp > Date.now() / 1000;
}

/** One WorkOS client per server, so the JWKS cache is reused across requests. */
export function createWorkOSVerifier(config: WorkOSAuthConfig): TokenVerifier {
  const workos = new WorkOS({ clientId: config.clientId, issuer: config.issuer });

  return async (token: string) => {
    const claims = await workos.userManagement.verifyAccessToken(token);
    if (!claims || !tokenMatchesRecipient(claims, config)) return null;
    return claims;
  };
}

/** Does not authorize an organization or grant database access. */
export function requireWorkOSUser(verifyToken: TokenVerifier): RequestHandler {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const header = req.headers.authorization;
    const match = typeof header === 'string'
      ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header)
      : null;

    if (!match || match[1].length > 16_384) {
      res.status(401).json({ error: 'missing_or_invalid_bearer_token' });
      return;
    }

    try {
      const claims = await verifyToken(match[1]);
      if (!claims ||
          typeof claims.sub !== 'string' || !claims.sub.startsWith('user_') ||
          typeof claims.sid !== 'string' || !claims.sid) {
        res.status(401).json({ error: 'invalid_access_token' });
        return;
      }

      // A verified external subject, NOT the local PostgreSQL users.id UUID.
      // No WorkOS role or org claim becomes Pulse Metrics authorization here.
      const identity: AuthenticatedIdentity = {
        provider: 'workos',
        subject: claims.sub,
        sessionId: claims.sid,
      };
      res.locals.authenticatedIdentity = identity;
      next();
    } catch {
      // A JWKS outage is not a bad password or an invalid token. Do not sign
      // the user out, expose the token, or log secret-bearing error objects.
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'authentication_verification_unavailable' });
    }
  };
}
