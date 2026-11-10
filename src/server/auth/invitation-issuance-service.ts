import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export type InvitableRole = 'admin' | 'member' | 'viewer';

export interface InvitationProposal {
  email: string;
  role: InvitableRole;
}

export interface InvitationIssueResult {
  invitation: {
    id: string;
    organizationId: string;
    invitedEmail: string;
    invitedRole: InvitableRole;
    expiresAt: string;
  };
  /** Raw secret is returned exactly once; the database stores only its digest. */
  oneTimeToken: string;
}

export class InvitationIssuanceDeniedError extends Error {
  constructor() { super('Invitation issuance is not authorized.'); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^user_[A-Za-z0-9_-]+$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const INVITATION_DURATION_MS = 24 * 60 * 60 * 1000;

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object') return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Called only after requireWorkOSUser has verified the bearer token.
 * PostgreSQL independently rechecks organization membership and the allowed
 * role matrix inside public.issue_organization_invitation().
 *
 * Does NOT email the invitee or redeem the invitation. Do not expose this API
 * on a public deployment until rate limiting and full redemption exist.
 */
export async function issueInvitationForIdentity(
  identity: AuthenticatedIdentity,
  organizationId: string,
  proposal: InvitationProposal,
): Promise<InvitationIssueResult> {
  if (identity.provider !== 'workos' ||
      typeof identity.subject !== 'string' ||
      identity.subject.length > 255 || !SUBJECT.test(identity.subject) ||
      typeof identity.sessionId !== 'string' || identity.sessionId.length === 0) {
    throw new TypeError('Verified WorkOS identity required.');
  }
  if (!UUID.test(organizationId)) throw new TypeError('Invalid organization UUID.');
  const email = proposal.email.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email) ||
      !['admin', 'member', 'viewer'].includes(proposal.role)) {
    throw new TypeError('Invalid invitation details.');
  }

  const token = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  const expiresAt = new Date(Date.now() + INVITATION_DURATION_MS);

  let invitationId: unknown;
  try {
    const result = await getDatabase().execute(sql`
      SELECT public.issue_organization_invitation(
        ${identity.subject}, ${organizationId}::uuid, ${email},
        ${proposal.role}, ${digest}, ${expiresAt.toISOString()}::timestamptz
      ) AS invitation_id
    `);
    invitationId = result.rows[0]?.invitation_id;
  } catch (error) {
    // SQLSTATE 42501 comes from the fixed security-definer permission guard;
    // do not reveal whether the organization exists or which role failed.
    if (sqlState(error) === '42501') throw new InvitationIssuanceDeniedError();
    throw error;
  }
  if (typeof invitationId !== 'string' || !UUID.test(invitationId)) {
    throw new Error('Invalid invitation response from database.');
  }

  return {
    invitation: {
      id: invitationId,
      organizationId,
      invitedEmail: email,
      invitedRole: proposal.role,
      expiresAt: expiresAt.toISOString(),
    },
    oneTimeToken: token,
  };
}
