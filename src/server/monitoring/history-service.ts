/**
 * D15C-5L — tenant-scoped, read-only PostgreSQL history candidate.
 * UNMOUNTED: No new HTTP route is registered by this module.
 *
 * WorkOS subject -> trusted local UUID, then transaction-scoped membership
 * verification and RLS. Never accept a browser-supplied user identity.
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { monitoredAgents, telemetrySamples } from '../../db/schema.js';
import { withOrganizationContext } from '../../db/tenant-context.js';
import { resolveAuthenticatedUserId } from '../auth/identity-provisioning.js';
import type { AuthenticatedIdentity } from '../auth/workos-auth.js';
import {
  MAX_HISTORY_POINTS, presentHistory,
  type HistoryRequest, type HistoryResponse,
} from './history-contract.js';

export class HistoryAccessDeniedError extends Error {
  constructor() { super('Organization access denied'); this.name = 'HistoryAccessDeniedError'; }
}
export class HistoryAgentNotFoundError extends Error {
  constructor() { super('Agent unavailable'); this.name = 'HistoryAgentNotFoundError'; }
}

/**
 * All sample reads occur inside the same tenant transaction as the agent
 * existence check. Explicit organization AND agent predicates accompany RLS.
 * Latest 501 rows are fetched so truncation is visible; never silently lie
 * about completeness. No raw JSON metrics or credentials are returned.
 */
export async function readHistoryForIdentity(
  identity: AuthenticatedIdentity,
  request: HistoryRequest,
): Promise<HistoryResponse> {
  const userId = await resolveAuthenticatedUserId(identity);
  try {
    return await withOrganizationContext({
      organizationId: request.organizationId, userId,
    }, async transaction => {
      const [agent] = await transaction
        .select({ id: monitoredAgents.id })
        .from(monitoredAgents)
        .where(and(
          eq(monitoredAgents.organizationId, request.organizationId),
          eq(monitoredAgents.id, request.agentId),
        ))
        .limit(1);

      if (!agent) throw new HistoryAgentNotFoundError();

      const rows = await transaction
        .select({
          recordedAt: telemetrySamples.recordedAt,
          receivedAt: telemetrySamples.receivedAt,
          cpuUsagePercent: telemetrySamples.cpuUsagePercent,
          memoryUsagePercent: telemetrySamples.memoryUsagePercent,
          diskUsagePercent: telemetrySamples.diskUsagePercent,
          networkReceiveBytesPerSecond: telemetrySamples.networkReceiveBytesPerSecond,
          networkTransmitBytesPerSecond: telemetrySamples.networkTransmitBytesPerSecond,
        })
        .from(telemetrySamples)
        .where(and(
          eq(telemetrySamples.organizationId, request.organizationId),
          eq(telemetrySamples.agentId, request.agentId),
          gte(telemetrySamples.recordedAt, request.since),
          lte(telemetrySamples.recordedAt, request.until),
        ))
        .orderBy(desc(telemetrySamples.recordedAt), desc(telemetrySamples.id))
        .limit(MAX_HISTORY_POINTS + 1);

      return presentHistory(request, rows);
    });
  } catch (error) {
    // The tenant helper refuses a non-member before setting tenant scope.
    if (error instanceof Error && error.message === 'Organization access denied.') {
      throw new HistoryAccessDeniedError();
    }
    throw error;
  }
}
