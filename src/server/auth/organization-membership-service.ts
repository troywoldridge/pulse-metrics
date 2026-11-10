import { and, eq, asc } from 'drizzle-orm';
import { organizationMemberships } from '../../db/schema.js';
import { withOrganizationContext } from '../../db/tenant-context.js';
import { resolveAuthenticatedUserId } from './identity-provisioning.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface MembershipRosterItem {
  userId: string;
  role: MembershipRole;
  displayName: string | null;
  joinedAt: Date;
}

export interface MembershipRoster {
  organizationId: string;
  members: MembershipRosterItem[];
}

export class MembershipAccessDeniedError extends Error {
  constructor() { super('Organization membership access denied.'); }
}

const MAX_ROSTER_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Explicit role policy. Future permissions require separate review and tests. */
export function canReadMembershipRoster(role: unknown): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Return only tenant-scoped membership display names/roles to organization
 * administrators. WorkOS profile email and global user data are never queried.
 *
 * The user UUID is derived from a verified bearer identity. Organization
 * membership is checked in withOrganizationContext() BEFORE tenant context
 * is installed, and the role check occurs in that same transaction.
 *
 * Does not grant invite, role-change, removal, or monitoring permissions.
 */
export async function listOrganizationMembersForIdentity(
  identity: AuthenticatedIdentity,
  organizationId: string,
): Promise<MembershipRoster> {
  if (!UUID.test(organizationId)) {
    throw new TypeError('A valid organization UUID is required.');
  }
  const userId = await resolveAuthenticatedUserId(identity);

  try {
    return await withOrganizationContext({ organizationId, userId }, async transaction => {
      const [callerMembership] = await transaction.select({ role: organizationMemberships.role })
        .from(organizationMemberships)
        .where(and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.userId, userId),
        ))
        .limit(1);

      if (!canReadMembershipRoster(callerMembership?.role)) {
        throw new MembershipAccessDeniedError();
      }

      const rows = await transaction.select({
        userId: organizationMemberships.userId,
        role: organizationMemberships.role,
        displayName: organizationMemberships.displayName,
        joinedAt: organizationMemberships.createdAt,
      })
        .from(organizationMemberships)
        .where(eq(organizationMemberships.organizationId, organizationId))
        .orderBy(asc(organizationMemberships.createdAt), asc(organizationMemberships.userId))
        .limit(MAX_ROSTER_SIZE + 1);

      // Avoid silently returning an incomplete member list until pagination is designed.
      if (rows.length > MAX_ROSTER_SIZE) {
        throw new Error('Membership roster pagination required.');
      }

      return { organizationId, members: rows };
    });
  } catch (error) {
    // The tenant helper deliberately refuses an organization before installing
    // tenant context when the caller has no membership there.
    if (error instanceof Error && error.message === 'Organization access denied.') {
      throw new MembershipAccessDeniedError();
    }
    throw error;
  }
}
