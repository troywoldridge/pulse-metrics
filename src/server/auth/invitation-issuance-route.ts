import type { RequestHandler } from 'express';
import {
  InvitationIssuanceDeniedError,
  issueInvitationForIdentity,
  type InvitationProposal,
  type InvitationIssueResult,
} from './invitation-issuance-service.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export type InvitationIssuer = (
  identity: AuthenticatedIdentity,
  organizationId: string,
  proposal: InvitationProposal,
) => Promise<InvitationIssueResult>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^user_[A-Za-z0-9_-]+$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

function verifiedIdentity(value: unknown): AuthenticatedIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const identity = value as Partial<AuthenticatedIdentity>;
  return identity.provider === 'workos' &&
    typeof identity.subject === 'string' && identity.subject.length <= 255 &&
    SUBJECT.test(identity.subject) &&
    typeof identity.sessionId === 'string' && identity.sessionId.length > 0
    ? identity as AuthenticatedIdentity : null;
}

/** Exact allowlist: no userId, tokenHash, expiry, organization or owner override. */
export function parseInvitationProposal(body: unknown): InvitationProposal | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 2 || !keys.includes('email') || !keys.includes('role') ||
      typeof fields.email !== 'string') return null;
  const email = fields.email.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) return null;
  if (fields.role !== 'admin' && fields.role !== 'member' &&
      fields.role !== 'viewer') return null;
  return { email, role: fields.role };
}

/**
 * Authenticated POST /api/organizations/:organizationId/invitations.
 * Never log the invitation secret. It is transmitted once to the authorized
 * issuer and is not currently redeemable (Phase 2E3C pending).
 */
export function createInvitationIssuanceRoute(
  issue: InvitationIssuer = issueInvitationForIdentity,
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
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'json_required' });
      return;
    }
    const proposal = parseInvitationProposal(req.body);
    if (!proposal) {
      res.status(400).json({ error: 'invalid_invitation_details' });
      return;
    }

    try {
      const result = await issue(identity, organizationId, proposal);
      // Narrowly select the response properties; never pass through arbitrary
      // properties from a service or database error to the caller.
      if (!result || result.invitation?.organizationId !== organizationId ||
          !UUID.test(result.invitation.id) ||
          result.invitation.invitedEmail !== proposal.email ||
          result.invitation.invitedRole !== proposal.role ||
          typeof result.invitation.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(result.invitation.expiresAt)) ||
          typeof result.oneTimeToken !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(result.oneTimeToken)) {
        throw new Error('Unexpected invitation response.');
      }
      res.status(201).json({
        invitation: {
          id: result.invitation.id,
          organizationId,
          invitedEmail: proposal.email,
          invitedRole: proposal.role,
          expiresAt: result.invitation.expiresAt,
        },
        oneTimeToken: result.oneTimeToken,
      });
    } catch (error) {
      if (error instanceof InvitationIssuanceDeniedError) {
        res.status(403).json({ error: 'organization_access_denied' });
        return;
      }
      // No SQL diagnostics, bearer claims, email address or token in errors.
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'invitation_issuance_unavailable' });
    }
  };
}
