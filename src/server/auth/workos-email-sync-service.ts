import { sql } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { resolveAuthenticatedUserId } from './identity-provisioning.js';
import {
  createLiveWorkOSVerifiedEmailLookup,
  type WorkOSUserFetcher,
  createVerifiedEmailLookup,
} from './workos-verified-email.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

/** Trusted server-only adapter. Never accept a browser email or emailVerified field. */
export type VerifiedEmailLookup = (identity: AuthenticatedIdentity) => Promise<string | null>;
export type IdentityProvisioner = (identity: AuthenticatedIdentity) => Promise<string>;
export type VerifiedEmailWriter = (subject: string, email: string | null) => Promise<string>;

export interface VerifiedEmailSyncResult {
  userId: string;
  verifiedEmail: string | null;
}

const SUBJECT = /^user_[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export class VerifiedEmailSyncUnavailableError extends Error {
  constructor() { super('Verified email synchronization is unavailable.'); }
}

/** Parameterized call to the restricted SECURITY DEFINER function. */
export async function persistWorkOSVerifiedEmail(
  subject: string, verifiedEmail: string | null,
): Promise<string> {
  const result = await getDatabase().execute(sql`
    SELECT public.sync_workos_verified_email(
      ${subject}, ${verifiedEmail}
    ) AS user_id
  `);
  const userId = result.rows[0]?.user_id;
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new VerifiedEmailSyncUnavailableError();
  }
  return userId;
}

function assertIdentity(identity: AuthenticatedIdentity): void {
  if (!identity || identity.provider !== 'workos' ||
      typeof identity.subject !== 'string' || identity.subject.length > 255 ||
      !SUBJECT.test(identity.subject) ||
      typeof identity.sessionId !== 'string' || identity.sessionId.length === 0) {
    throw new TypeError('Verified WorkOS identity is required.');
  }
}

/**
 * The lookup must freshly retrieve WorkOS emailVerified evidence.
 * An explicit unverified response clears both email and verification time.
 * A provider outage/malformed profile FAILS WITHOUT WRITING; the future
 * acceptance handler must not fall back to an earlier database attestation.
 *
 * The database function cannot independently check a WorkOS JWT or API
 * response. Never invoke this service from a route accepting identity/email.
 */
export function createVerifiedEmailSynchronizer(dependencies: {
  lookup: VerifiedEmailLookup;
  provision: IdentityProvisioner;
  persist: VerifiedEmailWriter;
}) {
  return async (identity: AuthenticatedIdentity): Promise<VerifiedEmailSyncResult> => {
    assertIdentity(identity);
    let verifiedEmail: string | null;
    try {
      verifiedEmail = await dependencies.lookup(identity);
    } catch {
      throw new VerifiedEmailSyncUnavailableError();
    }
    if (verifiedEmail !== null &&
        (typeof verifiedEmail !== 'string' || verifiedEmail.length > 320 ||
         verifiedEmail !== verifiedEmail.trim().toLowerCase() ||
         !EMAIL.test(verifiedEmail))) {
      throw new VerifiedEmailSyncUnavailableError();
    }

    try {
      const provisionedUserId = await dependencies.provision(identity);
      if (!UUID.test(provisionedUserId)) throw new Error('Bad identity UUID');
      const updatedUserId = await dependencies.persist(identity.subject, verifiedEmail);
      if (updatedUserId !== provisionedUserId) throw new Error('Identity mismatch');
      return { userId: updatedUserId, verifiedEmail };
    } catch {
      throw new VerifiedEmailSyncUnavailableError();
    }
  };
}

/** Production assembly; currently NOT mounted in Express or exposed via API. */
export function createLiveVerifiedEmailSynchronizer(environment: NodeJS.ProcessEnv = process.env) {
  return createVerifiedEmailSynchronizer({
    lookup: createLiveWorkOSVerifiedEmailLookup(environment),
    provision: resolveAuthenticatedUserId,
    persist: persistWorkOSVerifiedEmail,
  });
}

/** Explicitly injected provider fetcher for local tests; no WorkOS API needed. */
export function createTestableVerifiedEmailSynchronizer(
  fetchUser: WorkOSUserFetcher,
  provision: IdentityProvisioner,
  persist: VerifiedEmailWriter,
) {
  return createVerifiedEmailSynchronizer({
    lookup: createVerifiedEmailLookup(fetchUser), provision, persist,
  });
}
