import { eq, sql } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { withOrganizationContext } from '../../db/tenant-context.js';
import { organizationMemberships, organizations } from '../../db/schema.js';
import { resolveAuthenticatedUserId } from './identity-provisioning.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface OrganizationProposal {
  name: string;
  slug: string;
}

export class OrganizationSlugConflictError extends Error {
  constructor() { super('Organization slug is already in use.'); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ORGANIZATIONS_PER_PAGE = 50;

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== 'object') return undefined;
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string') return record.code;
    current = record.cause;
  }
  return undefined;
}

/**
 * Called exclusively after WorkOS bearer verification in requireWorkOSUser.
 * The user subject is derived from res.locals, never from the POST body.
 * Database function alone chooses owner role and writes the audit event.
 */
export async function createOrganizationForIdentity(
  identity: AuthenticatedIdentity,
  proposal: OrganizationProposal,
): Promise<OrganizationSummary> {
  // Ensure the verified user already exists (or is created) internally.
  await resolveAuthenticatedUserId(identity);

  try {
    const result = await getDatabase().execute(sql`
      SELECT organization_id, organization_slug, membership_role
      FROM public.create_workos_organization(
        ${identity.subject}, ${proposal.name}, ${proposal.slug}
      )
    `);
    const row = result.rows[0];
    if (!row || typeof row.organization_id !== 'string' ||
        !UUID.test(row.organization_id) ||
        row.organization_slug !== proposal.slug ||
        row.membership_role !== 'owner') {
      throw new Error('Unexpected organization creation response.');
    }
    return {
      id: row.organization_id,
      name: proposal.name.trim(),
      slug: row.organization_slug,
      role: 'owner',
    };
  } catch (error) {
    if (postgresCode(error) === '23505') {
      throw new OrganizationSlugConflictError();
    }
    throw error;
  }
}

/**
 * Fetch the caller's membership IDs under transaction-scoped user RLS,
 * then fetch each organization through withOrganizationContext(), which
 * rechecks membership and installs transaction-local tenant context.
 * Never accept an organization ID from the browser for this query.
 */
export async function listOrganizationsForIdentity(
  identity: AuthenticatedIdentity,
): Promise<OrganizationSummary[]> {
  const userId = await resolveAuthenticatedUserId(identity);
  const memberships = await getDatabase().transaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT
        set_config('app.current_organization_id', '', true),
        set_config('app.current_user_id', ${userId}, true)
    `);
    return transaction
      .select({
        organizationId: organizationMemberships.organizationId,
        role: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId))
      .limit(MAX_ORGANIZATIONS_PER_PAGE + 1);
  });

  // Fail closed rather than silently presenting an incomplete organization list.
  // Pagination is a later milestone before expanding SaaS account limits.
  if (memberships.length > MAX_ORGANIZATIONS_PER_PAGE) {
    throw new Error('Organization pagination is required.');
  }

  const result: OrganizationSummary[] = [];
  for (const membership of memberships) {
    const organization = await withOrganizationContext(
      { organizationId: membership.organizationId, userId },
      async (transaction) => {
        const [row] = await transaction
          .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
          .from(organizations)
          .where(eq(organizations.id, membership.organizationId))
          .limit(1);
        return row;
      },
    );
    if (!organization) {
      throw new Error('Authorized organization could not be loaded.');
    }
    result.push({ ...organization, role: membership.role });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}
