/** D15C-5Q — database-backed discovery of agents belonging to the caller's tenant. */
import { and, asc, eq, ne } from 'drizzle-orm';
import { monitoredAgents } from '../../db/schema.js';
import { withOrganizationContext } from '../../db/tenant-context.js';
import { resolveAuthenticatedUserId } from '../auth/identity-provisioning.js';
import type { AuthenticatedIdentity } from '../auth/workos-auth.js';
import {
  MAX_LISTED_AGENTS, isAgentUuid, parseAgentListResponse,
  type AgentListResponse, type ListedAgentStatus,
} from './agent-list-contract.js';

export class AgentListAccessDeniedError extends Error {
  constructor() { super('Organization access denied'); this.name = 'AgentListAccessDeniedError'; }
}

/** Never trusts a browser-provided identity; RLS context is transaction-local. */
export async function listAgentsForIdentity(
  identity: AuthenticatedIdentity, organizationId: string,
): Promise<AgentListResponse> {
  if (!isAgentUuid(organizationId)) throw new TypeError('Invalid organization');
  const userId = await resolveAuthenticatedUserId(identity);
  try {
    return await withOrganizationContext({ organizationId, userId }, async transaction => {
      const rows = await transaction
        .select({
          id: monitoredAgents.id,
          displayName: monitoredAgents.displayName,
          hostname: monitoredAgents.hostname,
          platform: monitoredAgents.platform,
          status: monitoredAgents.status,
          lastSeenAt: monitoredAgents.lastSeenAt,
        })
        .from(monitoredAgents)
        .where(and(
          eq(monitoredAgents.organizationId, organizationId),
          ne(monitoredAgents.status, 'revoked'),
        ))
        .orderBy(asc(monitoredAgents.displayName), asc(monitoredAgents.id))
        .limit(MAX_LISTED_AGENTS + 1);

      if (rows.length > MAX_LISTED_AGENTS) throw new Error('Agent-list pagination required');
      const response: AgentListResponse = {
        organizationId,
        agents: rows.map(row => ({
          id: row.id,
          displayName: row.displayName,
          hostname: row.hostname,
          platform: row.platform,
          status: row.status as ListedAgentStatus,
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        })),
      };
      if (!parseAgentListResponse(response, organizationId)) throw new Error('Unexpected agent data');
      return response;
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Organization access denied.') {
      throw new AgentListAccessDeniedError();
    }
    throw error;
  }
}
