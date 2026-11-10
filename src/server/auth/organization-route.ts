import type { RequestHandler } from 'express';
import {
  createOrganizationForIdentity,
  listOrganizationsForIdentity,
  OrganizationSlugConflictError,
  type OrganizationProposal,
  type OrganizationSummary,
} from './organization-service.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export type CreateOrganization = (
  identity: AuthenticatedIdentity,
  proposal: OrganizationProposal,
) => Promise<OrganizationSummary>;
export type ListOrganizations = (
  identity: AuthenticatedIdentity,
) => Promise<OrganizationSummary[]>;

function authenticatedIdentity(value: unknown): AuthenticatedIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const identity = value as Partial<AuthenticatedIdentity>;
  return identity.provider === 'workos' &&
    typeof identity.subject === 'string' &&
    identity.subject.length <= 255 &&
    /^user_[A-Za-z0-9_-]+$/.test(identity.subject) &&
    typeof identity.sessionId === 'string' && identity.sessionId.length > 0
    ? identity as AuthenticatedIdentity
    : null;
}

/** Only permit the two user-supplied organization details. No role or user ID. */
export function parseOrganizationProposal(body: unknown): OrganizationProposal | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 2 || !keys.includes('name') || !keys.includes('slug')) return null;
  if (typeof fields.name !== 'string' || typeof fields.slug !== 'string') return null;

  const name = fields.name.trim();
  const slug = fields.slug;
  if (name.length < 1 || name.length > 160 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(name) ||
      slug.length < 1 || slug.length > 80 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return null;
  }
  return { name, slug };
}

export function createCreateOrganizationRoute(
  create: CreateOrganization = createOrganizationForIdentity,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = authenticatedIdentity(res.locals.authenticatedIdentity);
    if (!identity) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'json_required' });
      return;
    }
    const proposal = parseOrganizationProposal(req.body);
    if (!proposal) {
      res.status(400).json({ error: 'invalid_organization_details' });
      return;
    }

    try {
      const organization = await create(identity, proposal);
      res.status(201).json({ organization });
    } catch (error) {
      if (error instanceof OrganizationSlugConflictError) {
        res.status(409).json({ error: 'organization_slug_taken' });
        return;
      }
      // Do not log or return SQL errors, user-subjects, tokens, or credentials.
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'organization_creation_unavailable' });
    }
  };
}

export function createListOrganizationsRoute(
  list: ListOrganizations = listOrganizationsForIdentity,
): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = authenticatedIdentity(res.locals.authenticatedIdentity);
    if (!identity) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }
    try {
      res.json({ organizations: await list(identity) });
    } catch {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'organization_list_unavailable' });
    }
  };
}
