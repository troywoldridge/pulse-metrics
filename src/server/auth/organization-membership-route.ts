import type { RequestHandler } from 'express';
import {
  listOrganizationMembersForIdentity,
  MembershipAccessDeniedError,
  type MembershipRoster,
} from './organization-membership-service.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export type MembershipRosterLoader = (
  identity: AuthenticatedIdentity,
  organizationId: string,
) => Promise<MembershipRoster>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function verifiedIdentity(value: unknown): AuthenticatedIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AuthenticatedIdentity>;
  return candidate.provider === 'workos' &&
    typeof candidate.subject === 'string' &&
    candidate.subject.length <= 255 &&
    /^user_[A-Za-z0-9_-]+$/.test(candidate.subject) &&
    typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
    ? candidate as AuthenticatedIdentity : null;
}

/** Mount only after requireWorkOSUser; fail closed when mounted without it. */
export function createMembershipRosterRoute(
  load: MembershipRosterLoader = listOrganizationMembersForIdentity,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = verifiedIdentity(res.locals.authenticatedIdentity);
    if (!identity) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const organizationId = req.params.organizationId;
    if (typeof organizationId !== 'string' || !UUID.test(organizationId)) {
      res.status(400).json({ error: 'invalid_organization_id' });
      return;
    }

    try {
      const roster = await load(identity, organizationId);
      // Do not forward arbitrary properties if a dependency returns an invalid shape.
      if (roster.organizationId !== organizationId || !Array.isArray(roster.members)) {
        throw new Error('Unexpected membership roster response.');
      }
      res.json({ organizationId, members: roster.members });
    } catch (error) {
      if (error instanceof MembershipAccessDeniedError) {
        // 403 for either missing membership or inadequate role. No resource details.
        res.status(403).json({ error: 'organization_access_denied' });
        return;
      }
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'membership_roster_unavailable' });
    }
  };
}
