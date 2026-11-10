import { WorkOS } from '@workos-inc/node';
import type { AuthenticatedIdentity } from './workos-auth.js';

/**
 * Phase 2E3C2: read-only, server-side verified-email evidence.
 *
 * Never accept profile data, email addresses, or `email_verified` claims from
 * a browser. `identity` must come from requireWorkOSUser() after JWT verification.
 * This module deliberately does NOT persist an email or redeem invitations.
 */
export type WorkOSUserFetcher = (workosSubject: string) => Promise<unknown>;

export class VerifiedEmailEvidenceUnavailableError extends Error {
  constructor() {
    super('Verified email evidence is unavailable.');
  }
}

const SUBJECT = /^user_[A-Za-z0-9_-]+$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

function assertVerifiedIdentity(identity: AuthenticatedIdentity): void {
  if (!identity || identity.provider !== 'workos' ||
      typeof identity.subject !== 'string' || identity.subject.length > 255 ||
      !SUBJECT.test(identity.subject) ||
      typeof identity.sessionId !== 'string' || identity.sessionId.length === 0) {
    throw new TypeError('Verified WorkOS identity is required.');
  }
}

/**
 * In the WorkOS Node SDK, User.emailVerified is the canonical API's
 * `email_verified` boolean mapped to camelCase. Only the explicit value true
 * is acceptable as evidence. A missing or malformed flag is NOT verification.
 *
 * Returns a normalized verified email, or null when WorkOS explicitly reports
 * an unverified email. API failures and malformed profiles throw a sanitized
 * error; callers must never fall back to a cached email or a browser claim.
 */
export function createVerifiedEmailLookup(fetchUser: WorkOSUserFetcher) {
  return async (identity: AuthenticatedIdentity): Promise<string | null> => {
    assertVerifiedIdentity(identity);
    let profile: unknown;
    try {
      profile = await fetchUser(identity.subject);
    } catch {
      throw new VerifiedEmailEvidenceUnavailableError();
    }

    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new VerifiedEmailEvidenceUnavailableError();
    }
    const user = profile as Record<string, unknown>;
    if (user.id !== identity.subject ||
        typeof user.emailVerified !== 'boolean') {
      throw new VerifiedEmailEvidenceUnavailableError();
    }
    if (user.emailVerified === false) return null;

    if (typeof user.email !== 'string') {
      throw new VerifiedEmailEvidenceUnavailableError();
    }
    const email = user.email.trim().toLowerCase();
    if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) {
      throw new VerifiedEmailEvidenceUnavailableError();
    }
    return email;
  };
}

/**
 * Construct a WorkOS management API reader with a server-only API key.
 * Does not make an API request until the returned function is invoked.
 * The API key must NEVER be prefixed VITE_ or sent to the browser.
 */
export function createLiveWorkOSVerifiedEmailLookup(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const apiKey = environment.WORKOS_API_KEY?.trim();
  const clientId = environment.WORKOS_CLIENT_ID?.trim();
  const issuer = environment.WORKOS_TOKEN_ISSUER?.trim();

  if (!apiKey || !apiKey.startsWith('sk_')) {
    throw new Error('A server-only WORKOS_API_KEY is required.');
  }
  if (!clientId || !/^client_[A-Za-z0-9_-]+$/.test(clientId)) {
    throw new Error('A valid WORKOS_CLIENT_ID is required.');
  }
  if (!issuer) throw new Error('A verified WORKOS_TOKEN_ISSUER is required.');
  try {
    const parsed = new URL(issuer);
    if (parsed.protocol !== 'https:' || !parsed.hostname ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Invalid issuer');
    }
  } catch {
    throw new Error('WORKOS_TOKEN_ISSUER must be an HTTPS issuer URL.');
  }

  // API-key mode is required for userManagement.getUser(). The issuer/client
  // binding matches the existing verified JWT middleware configuration.
  const workos = new WorkOS(apiKey, { clientId, issuer });
  return createVerifiedEmailLookup(subject => workos.userManagement.getUser(subject));
}
