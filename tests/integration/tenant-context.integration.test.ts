import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../../src/db/client.js";
import {
  monitoredAgents,
  telemetrySamples,
} from "../../src/db/schema.js";
import { withOrganizationContext } from "../../src/db/tenant-context.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(name: string): string {
  const value = process.env[name];

  if (!value || !UUID_PATTERN.test(value)) {
    throw new Error(`${name} must contain a valid test UUID.`);
  }

  return value;
}

const ORGANIZATION_A = requiredUuid(
  "TENANT_TEST_ORGANIZATION_A_ID",
);
const ORGANIZATION_B = requiredUuid(
  "TENANT_TEST_ORGANIZATION_B_ID",
);
const USER_A = requiredUuid("TENANT_TEST_USER_A_ID");
const USER_B = requiredUuid("TENANT_TEST_USER_B_ID");

const PHASE = process.env.TENANT_TEST_PHASE;

if (PHASE !== "initial" && PHASE !== "revoked") {
  throw new Error(
    "TENANT_TEST_PHASE must be either 'initial' or 'revoked'.",
  );
}

const NONEXISTENT_USER = "00000000-0000-4000-8000-000000000099";
const NONEXISTENT_ORGANIZATION =
  "00000000-0000-4000-8000-000000000098";

test(
  `PostgreSQL tenant isolation integration (${PHASE} phase)`,
  async () => {
    try {
      const database = getDatabase();

      const identity = await database.execute(
        sql`SELECT current_user AS role`,
      );

      assert.equal(
        identity.rows[0]?.role,
        "pulse_metrics_app",
        "Application-path tests must use the restricted runtime role.",
      );

      if (PHASE === "initial") {
        await assert.rejects(
          () =>
            withOrganizationContext(
              {
                organizationId: "not-a-valid-uuid",
                userId: USER_A,
              },
              async () => {
                assert.fail("Invalid organization UUID must be rejected.");
              },
            ),
          TypeError,
        );

        await assert.rejects(
          () =>
            withOrganizationContext(
              {
                organizationId: ORGANIZATION_A,
                userId: "not-a-valid-uuid",
              },
              async () => {
                assert.fail("Invalid user UUID must be rejected.");
              },
            ),
          TypeError,
        );

        await assert.rejects(
          () =>
            withOrganizationContext(
              {
                organizationId: ORGANIZATION_A,
                userId: NONEXISTENT_USER,
              },
              async () => {
                assert.fail("A nonexistent user must be denied.");
              },
            ),
          /Organization access denied/,
        );

        await assert.rejects(
          () =>
            withOrganizationContext(
              {
                organizationId: NONEXISTENT_ORGANIZATION,
                userId: USER_A,
              },
              async () => {
                assert.fail("A nonexistent organization must be denied.");
              },
            ),
          /Organization access denied/,
        );

        const tenantA = await withOrganizationContext(
          {
            organizationId: ORGANIZATION_A,
            userId: USER_A,
          },
          async (transaction) => {
            const agents = await transaction
              .select({
                organizationId: monitoredAgents.organizationId,
                displayName: monitoredAgents.displayName,
              })
              .from(monitoredAgents);

            const telemetry = await transaction
              .select({
                organizationId: telemetrySamples.organizationId,
                metrics: telemetrySamples.metrics,
              })
              .from(telemetrySamples);

            const backend = await transaction.execute(
              sql`SELECT pg_backend_pid() AS backend_pid`,
            );

            return {
              agents,
              telemetry,
              backendPid: backend.rows[0]?.backend_pid,
            };
          },
        );

        assert.deepEqual(tenantA.agents, [
          {
            organizationId: ORGANIZATION_A,
            displayName: "Isolation Test Agent A",
          },
        ]);

        assert.equal(tenantA.telemetry.length, 1);
        assert.equal(
          tenantA.telemetry[0]?.organizationId,
          ORGANIZATION_A,
        );
        assert.equal(
          tenantA.telemetry[0]?.metrics.test,
          "organization-a",
        );

        const afterTenantA = await database.execute(sql`
          SELECT
            pg_backend_pid() AS backend_pid,
            NULLIF(
              current_setting('app.current_organization_id', true),
              ''
            ) AS organization_id,
            NULLIF(
              current_setting('app.current_user_id', true),
              ''
            ) AS user_id
        `);

        assert.equal(
          afterTenantA.rows[0]?.backend_pid,
          tenantA.backendPid,
          "The single-connection pool should reuse the same PostgreSQL backend.",
        );

        assert.equal(
          afterTenantA.rows[0]?.organization_id,
          null,
          "Organization context must be cleared after the transaction.",
        );

        assert.equal(
          afterTenantA.rows[0]?.user_id,
          null,
          "User context must be cleared after the transaction.",
        );

        await assert.rejects(
          () =>
            withOrganizationContext(
              {
                organizationId: ORGANIZATION_B,
                userId: USER_A,
              },
              async () => {
                assert.fail(
                  "User A must not access Organization B.",
                );
              },
            ),
          /Organization access denied/,
        );

        const tenantB = await withOrganizationContext(
          {
            organizationId: ORGANIZATION_B,
            userId: USER_B,
          },
          async (transaction) => {
            const agents = await transaction
              .select({
                organizationId: monitoredAgents.organizationId,
                displayName: monitoredAgents.displayName,
              })
              .from(monitoredAgents);

            const telemetry = await transaction
              .select({
                organizationId: telemetrySamples.organizationId,
                metrics: telemetrySamples.metrics,
              })
              .from(telemetrySamples);

            const backend = await transaction.execute(
              sql`SELECT pg_backend_pid() AS backend_pid`,
            );

            return {
              agents,
              telemetry,
              backendPid: backend.rows[0]?.backend_pid,
            };
          },
        );

        assert.deepEqual(tenantB.agents, [
          {
            organizationId: ORGANIZATION_B,
            displayName: "Isolation Test Agent B",
          },
        ]);

        assert.equal(tenantB.telemetry.length, 1);
        assert.equal(
          tenantB.telemetry[0]?.organizationId,
          ORGANIZATION_B,
        );
        assert.equal(
          tenantB.telemetry[0]?.metrics.test,
          "organization-b",
        );

        assert.equal(
          tenantB.backendPid,
          tenantA.backendPid,
          "Tenant A and B should be tested on the same pooled backend.",
        );

        const afterTenantB = await database.execute(sql`
          SELECT
            NULLIF(
              current_setting('app.current_organization_id', true),
              ''
            ) AS organization_id,
            NULLIF(
              current_setting('app.current_user_id', true),
              ''
            ) AS user_id
        `);

        assert.equal(afterTenantB.rows[0]?.organization_id, null);
        assert.equal(afterTenantB.rows[0]?.user_id, null);

        const unscopedAgents = await database
          .select()
          .from(monitoredAgents);

        const unscopedTelemetry = await database
          .select()
          .from(telemetrySamples);

        assert.equal(
          unscopedAgents.length,
          0,
          "Unscoped agent queries must return no tenant rows.",
        );

        assert.equal(
          unscopedTelemetry.length,
          0,
          "Unscoped telemetry queries must return no tenant rows.",
        );
      }

      if (PHASE === "revoked") {
        await assert.rejects(
          () =>
            withOrganizationContext(
              {
                organizationId: ORGANIZATION_A,
                userId: USER_A,
              },
              async () => {
                assert.fail(
                  "A user whose membership was revoked must be denied.",
                );
              },
            ),
          /Organization access denied/,
        );

        const organizationBAgents = await withOrganizationContext(
          {
            organizationId: ORGANIZATION_B,
            userId: USER_B,
          },
          async (transaction) =>
            transaction
              .select({
                organizationId: monitoredAgents.organizationId,
                displayName: monitoredAgents.displayName,
              })
              .from(monitoredAgents),
        );

        assert.deepEqual(organizationBAgents, [
          {
            organizationId: ORGANIZATION_B,
            displayName: "Isolation Test Agent B",
          },
        ]);
      }
    } finally {
      await closeDatabase();
    }
  },
);
