import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { createLiveWorkOSVerifiedEmailLookup } from './workos-verified-email.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export type VerifiedEmailEvidenceReader = (
  identity: AuthenticatedIdentity,
) => Promise<string | null>;

export type InvitationAcceptanceExecutor = (
  subject: string,
  verifiedEmail: string | null,
  tokenHash: string,
) => Promise<InvitationAcceptanceResult | null>;

export interface InvitationAcceptanceResult {
  organizationId: string;
  membershipRole: 'admin' | 'member' | 'viewer';
}

export class InvitationNotAvailableError extends Error {
  constructor() { super('Invitation unavailable.'); }
}

export class InvitationAcceptanceUnavailableError extends Error {
  constructor() { super('Invitation acceptance is temporarily unavailable.'); }
}

const SUBJECT = /^user_[A-Za-z0-9_-]+$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RAW_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function assertIdentity(identity: AuthenticatedIdentity): void {
  if (!identity || identity.provider !== 'workos' ||
      typeof identity.subject !== 'string' || identity.subject.length > 255 ||
      !SUBJECT.test(identity.subject) || typeof identity.sessionId !== 'string' ||
      identity.sessionId.length === 0) {
    throw new TypeError('Verified WorkOS identity required.');
  }
}

/** Issuance generates exactly 32 random bytes encoded as canonical base64url. */
export function isCanonicalInvitationToken(token: unknown): token is string {
  if (typeof token !== 'string' || !RAW_TOKEN.test(token)) return false;
  try {
    const bytes = Buffer.from(token, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === token;
  } catch { return false; }
}

function getSqlState(error: unknown): string | undefined {
  let candidate = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!candidate || typeof candidate !== 'object') return undefined;
    const node = candidate as { code?: unknown; cause?: unknown };
    if (typeof node.code === 'string') return node.code;
    candidate = node.cause;
  }
  return undefined;
}

/**
 * Transactional database boundary. The verified-email UPDATE obtains a row
 * lock held through the invitation acceptance attempt. The acceptance runs in
 * a SAVEPOINT so an invalid/replayed invitation cannot undo the email refresh.
 * No browser-provided email or pre-hashed token reaches this adapter.
 *
 * The database functions trust the verified backend: SQL alone cannot prove
 * the subject or fresh WorkOS profile. Do not mount this without auth + rate
 * limiting and end-to-end authorization tests.
 */
export async function synchronizeAndAcceptInvitation(
  subject: string, verifiedEmail: string | null, tokenHash: string,
): Promise<InvitationAcceptanceResult | null> {
  return getDatabase().transaction(async tx => {
    const provisioned = await tx.execute(sql`
      SELECT public.resolve_workos_user(${subject}) AS user_id
    `);
    const provisionedId = provisioned.rows[0]?.user_id;
    if (typeof provisionedId !== 'string' || !UUID.test(provisionedId)) {
      throw new Error('Invalid provisioned identity.');
    }

    const synced = await tx.execute(sql`
      SELECT public.sync_workos_verified_email(${subject}, ${verifiedEmail}) AS user_id
    `);
    if (synced.rows[0]?.user_id !== provisionedId) {
      throw new Error('Verified email synchronization identity mismatch.');
    }

    // An explicit WorkOS unverified response clears stale evidence and stops.
    if (verifiedEmail === null) return null;

    try {
      // Drizzle nested transactions use PostgreSQL SAVEPOINTs. A failed
      // acceptance rolls back only the acceptance attempt, NOT the fresh
      // verified-email synchronization above.
      const result = await tx.transaction(async nested => {
        const response = await nested.execute(sql`
          SELECT organization_id, membership_role
          FROM public.accept_organization_invitation(${subject}, ${tokenHash})
        `);
        const row = response.rows[0];
        if (!row || typeof row.organization_id !== 'string' ||
            !UUID.test(row.organization_id) ||
            (row.membership_role !== 'admin' &&
             row.membership_role !== 'member' &&
             row.membership_role !== 'viewer')) {
          throw new Error('Malformed acceptance database response.');
        }
        return {
          organizationId: row.organization_id,
          membershipRole: row.membership_role,
        } satisfies InvitationAcceptanceResult;
      });
      return result;
    } catch (error) {
      // Missing, mismatched, expired, revoked or used invitation. A membership
      // primary-key collision similarly rolls back consumption, not sync.
      if (getSqlState(error) === 'P0002' || getSqlState(error) === '23505') {
        return null;
      }
      throw error;
    }
  });
}

/**
 * Injectable assembly for tests. Fetches current server-side WorkOS evidence
 * for EVERY attempt, then calls the transactional PostgreSQL boundary once.
 */
export function createInvitationAcceptanceService(dependencies: {
  lookup: VerifiedEmailEvidenceReader;
  execute: InvitationAcceptanceExecutor;
}) {
  return async (
    identity: AuthenticatedIdentity,
    rawToken: string,
  ): Promise<InvitationAcceptanceResult> => {
    assertIdentity(identity);
    if (!isCanonicalInvitationToken(rawToken)) {
      throw new TypeError('Invalid invitation token.');
    }
    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');

    let email: string | null;
    try {
      email = await dependencies.lookup(identity);
    } catch {
      throw new InvitationAcceptanceUnavailableError();
    }
    if (email !== null &&
        (typeof email !== 'string' || email !== email.trim().toLowerCase() ||
         email.length > 320 || !EMAIL.test(email))) {
      throw new InvitationAcceptanceUnavailableError();
    }

    let accepted: InvitationAcceptanceResult | null;
    try {
      accepted = await dependencies.execute(identity.subject, email, tokenHash);
    } catch {
      throw new InvitationAcceptanceUnavailableError();
    }
    if (accepted === null) throw new InvitationNotAvailableError();
    if (!accepted || !UUID.test(accepted.organizationId) ||
        !['admin', 'member', 'viewer'].includes(accepted.membershipRole)) {
      throw new InvitationAcceptanceUnavailableError();
    }
    return accepted;
  };
}

/** NOT mounted in server.ts; needs rate limiting and full HTTP+DB tests. */
export async function acceptInvitationForIdentity(
  identity: AuthenticatedIdentity,
  rawToken: string,
): Promise<InvitationAcceptanceResult> {
  assertIdentity(identity);
  if (!isCanonicalInvitationToken(rawToken)) {
    throw new TypeError('Invalid invitation token.');
  }
  let lookup: VerifiedEmailEvidenceReader;
  try {
    lookup = createLiveWorkOSVerifiedEmailLookup();
  } catch {
    throw new InvitationAcceptanceUnavailableError();
  }
  return createInvitationAcceptanceService({
    lookup,
    execute: synchronizeAndAcceptInvitation,
  })(identity, rawToken);
}
