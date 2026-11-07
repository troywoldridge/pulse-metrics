import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDatabase } from "./client.js";
import * as schema from "./schema.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OrganizationContext {
  organizationId: string;
  userId: string | null;
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
 * Execute all tenant data work in a single transaction with transaction-local
 * PostgreSQL settings consumed by Row-Level Security policies.
 *
 * Do not set these settings with a pool-level query: doing so can leak tenant
 * context between requests when a pooled connection is reused.
 */
export async function withOrganizationContext<T>(
  context: OrganizationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertUuid(context.organizationId, "organizationId");
  if (context.userId) assertUuid(context.userId, "userId");

  return getDatabase().transaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT
        set_config(
          'app.current_organization_id',
          ${context.organizationId},
          true
        ),
        set_config(
          'app.current_user_id',
          ${context.userId ?? ""},
          true
        )
    `);

    return operation(transaction as TenantTransaction);
  });
}
