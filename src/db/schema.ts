import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Tenant context is transaction-local. Every application query touching
 * tenant data must run through withOrganizationContext().
 *
 * The runtime database role must not be a superuser, have BYPASSRLS, or own
 * these tables. Tables are FORCE ROW LEVEL SECURITY protected in migrations.
 */
const activeOrganizationId = sql`NULLIF(current_setting('app.current_organization_id', true), '')::uuid`;
const activeUserId = sql`NULLIF(current_setting('app.current_user_id', true), '')::uuid`;

export const membershipRole = pgEnum("membership_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const agentStatus = pgEnum("agent_status", [
  "pending",
  "active",
  "offline",
  "revoked",
]);

export const auditActorType = pgEnum("audit_actor_type", [
  "user",
  "agent",
  "system",
]);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("organizations_slug_unique").on(table.slug),
    pgPolicy("organizations_member_read", {
      for: "select",
      using: sql`
        ${table.id} = ${activeOrganizationId}
        OR EXISTS (
          SELECT 1
          FROM organization_memberships AS membership
          WHERE membership.organization_id = ${table.id}
            AND membership.user_id = ${activeUserId}
        )
      `,
    }),
    pgPolicy("organizations_active_tenant_write", {
      for: "all",
      using: sql`${table.id} = ${activeOrganizationId}`,
      withCheck: sql`${table.id} = ${activeOrganizationId}`,
    }),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authProvider: varchar("auth_provider", { length: 40 }).notNull(),
    authSubject: varchar("auth_subject", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }),
    emailVerifiedAt: timestamp("email_verified_at", {
      withTimezone: true,
      mode: "date",
    }),
    displayName: varchar("display_name", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("users_auth_identity_unique").on(
      table.authProvider,
      table.authSubject,
    ),
    index("users_email_index").on(table.email),
    pgPolicy("users_self_read", {
      for: "select",
      using: sql`${table.id} = ${activeUserId}`,
    }),
    pgPolicy("users_self_write", {
      for: "all",
      using: sql`${table.id} = ${activeUserId}`,
      withCheck: sql`${table.id} = ${activeUserId}`,
    }),
  ],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").default("member").notNull(),
    // Tenant-scoped display name avoids exposing a user's global profile/email
    // to every member of every organization.
    displayName: varchar("display_name", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "organization_memberships_pk",
      columns: [table.organizationId, table.userId],
    }),
    index("organization_memberships_user_index").on(table.userId),
    pgPolicy("organization_memberships_member_read", {
      for: "select",
      using: sql`
        ${table.organizationId} = ${activeOrganizationId}
        OR ${table.userId} = ${activeUserId}
      `,
    }),
    pgPolicy("organization_memberships_active_tenant_write", {
      for: "all",
      using: sql`${table.organizationId} = ${activeOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${activeOrganizationId}`,
    }),
  ],
);

export const monitoredAgents = pgTable(
  "monitored_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    hostname: varchar("hostname", { length: 255 }).notNull(),
    platform: varchar("platform", { length: 40 }).notNull(),
    architecture: varchar("architecture", { length: 40 }).notNull(),
    agentVersion: varchar("agent_version", { length: 40 }),
    status: agentStatus("status").default("pending").notNull(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "date",
    }),
    enrolledAt: timestamp("enrolled_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("monitored_agents_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("monitored_agents_org_status_index").on(
      table.organizationId,
      table.status,
    ),
    index("monitored_agents_org_last_seen_index").on(
      table.organizationId,
      table.lastSeenAt,
    ),
    pgPolicy("monitored_agents_tenant_access", {
      for: "all",
      using: sql`${table.organizationId} = ${activeOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${activeOrganizationId}`,
    }),
  ],
);

export const agentEnrollmentTokens = pgTable(
  "agent_enrollment_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenPrefix: varchar("token_prefix", { length: 16 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    label: varchar("label", { length: 120 }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    maxUses: integer("max_uses").default(1).notNull(),
    uses: integer("uses").default(0).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("agent_enrollment_tokens_hash_unique").on(table.tokenHash),
    index("agent_enrollment_tokens_org_index").on(table.organizationId),
    check(
      "agent_enrollment_tokens_hash_format",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "agent_enrollment_tokens_usage_valid",
      sql`${table.maxUses} > 0 AND ${table.uses} >= 0 AND ${table.uses} <= ${table.maxUses}`,
    ),
    // Enrollment secrets are intentionally inaccessible to ordinary app
    // queries. A narrowly scoped verifier will be added with agent enrollment.
    pgPolicy("agent_enrollment_tokens_deny_direct_access", {
      for: "all",
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
);

export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    tokenPrefix: varchar("token_prefix", { length: 16 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().default(["telemetry:write"]).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.agentId],
      foreignColumns: [monitoredAgents.organizationId, monitoredAgents.id],
      name: "agent_credentials_agent_tenant_fk",
    }).onDelete("cascade"),
    uniqueIndex("agent_credentials_token_hash_unique").on(table.tokenHash),
    index("agent_credentials_agent_index").on(
      table.organizationId,
      table.agentId,
    ),
    check(
      "agent_credentials_hash_format",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    pgPolicy("agent_credentials_deny_direct_access", {
      for: "all",
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
);

export const telemetrySamples = pgTable(
  "telemetry_samples",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    recordedAt: timestamp("recorded_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    cpuUsagePercent: real("cpu_usage_percent"),
    memoryUsagePercent: real("memory_usage_percent"),
    diskUsagePercent: real("disk_usage_percent"),
    networkReceiveBytesPerSecond: bigint("network_receive_bytes_per_second", {
      mode: "number",
    }),
    networkTransmitBytesPerSecond: bigint("network_transmit_bytes_per_second", {
      mode: "number",
    }),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.agentId],
      foreignColumns: [monitoredAgents.organizationId, monitoredAgents.id],
      name: "telemetry_samples_agent_tenant_fk",
    }).onDelete("restrict"),
    index("telemetry_samples_org_agent_time_index").on(
      table.organizationId,
      table.agentId,
      table.recordedAt,
    ),
    index("telemetry_samples_org_time_index").on(
      table.organizationId,
      table.recordedAt,
    ),
    check(
      "telemetry_samples_cpu_range",
      sql`${table.cpuUsagePercent} IS NULL OR (${table.cpuUsagePercent} >= 0 AND ${table.cpuUsagePercent} <= 100)`,
    ),
    check(
      "telemetry_samples_memory_range",
      sql`${table.memoryUsagePercent} IS NULL OR (${table.memoryUsagePercent} >= 0 AND ${table.memoryUsagePercent} <= 100)`,
    ),
    check(
      "telemetry_samples_disk_range",
      sql`${table.diskUsagePercent} IS NULL OR (${table.diskUsagePercent} >= 0 AND ${table.diskUsagePercent} <= 100)`,
    ),
    check(
      "telemetry_samples_nonnegative_network",
      sql`
        (${table.networkReceiveBytesPerSecond} IS NULL OR ${table.networkReceiveBytesPerSecond} >= 0)
        AND
        (${table.networkTransmitBytesPerSecond} IS NULL OR ${table.networkTransmitBytesPerSecond} >= 0)
      `,
    ),
    pgPolicy("telemetry_samples_tenant_access", {
      for: "all",
      using: sql`${table.organizationId} = ${activeOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${activeOrganizationId}`,
    }),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actorType: auditActorType("actor_type").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorAgentId: uuid("actor_agent_id"),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    subjectType: varchar("subject_type", { length: 80 }),
    subjectId: varchar("subject_id", { length: 160 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_events_org_time_index").on(
      table.organizationId,
      table.createdAt,
    ),
    index("audit_events_org_event_index").on(
      table.organizationId,
      table.eventType,
    ),
    pgPolicy("audit_events_tenant_read", {
      for: "select",
      using: sql`${table.organizationId} = ${activeOrganizationId}`,
    }),
    pgPolicy("audit_events_tenant_insert", {
      for: "insert",
      withCheck: sql`${table.organizationId} = ${activeOrganizationId}`,
    }),
    // No UPDATE or DELETE policy: audit records are append-only for the
    // application role. Database owners remain responsible for retention.
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type User = typeof users.$inferSelect;
export type OrganizationMembership =
  typeof organizationMemberships.$inferSelect;
export type MonitoredAgent = typeof monitoredAgents.$inferSelect;
export type TelemetrySample = typeof telemetrySamples.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
