import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDatabase } from "./client.js";
import * as schema from "./schema.js";
import { organizationMemberships } from "./schema.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OrganizationContext {
  organizationId: string;
  userId: string;
}

export type TenantTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a valid UUID.`);
  }
}

/**
 * Execute user work in a transaction with a verified organization membership.
 *
 * The user's identity is set first while organization context is empty. RLS
 * permits the user to read only their own membership rows. Only after that
 * membership is confirmed is the organization context installed. This order
 * prevents a caller from selecting an arbitrary organization ID and relying
 * on the helper to grant access.
 *
 * Keep all tenant queries inside the callback. Never set these values through
 * a pool-level query; transaction-local settings prevent context leakage
 * between requests when pooled connections are reused.
 */
export async function withOrganizationContext<T>(
  context: OrganizationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertUuid(context.organizationId, "organizationId");
  assertUuid(context.userId, "userId");

  return getDatabase().transaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT
        set_config('app.current_organization_id', '', true),
        set_config('app.current_user_id', ${context.userId}, true)
    `);

    const [membership] = await transaction
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, context.organizationId),
          eq(organizationMemberships.userId, context.userId),
        ),
      )
      .limit(1);

    if (!membership) {
      throw new Error("Organization access denied.");
    }

    await transaction.execute(sql`
      SELECT set_config(
        'app.current_organization_id',
        ${context.organizationId},
        true
      )
    `);

    return operation(transaction as TenantTransaction);
  });
}
