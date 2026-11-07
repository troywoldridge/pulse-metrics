CREATE TYPE "public"."agent_status" AS ENUM('pending', 'active', 'offline', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_prefix" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"scopes" jsonb DEFAULT '["telemetry:write"]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_credentials_hash_format" CHECK ("agent_credentials"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_prefix" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"label" varchar(120),
	"created_by_user_id" uuid,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_enrollment_tokens_hash_format" CHECK ("agent_enrollment_tokens"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "agent_enrollment_tokens_usage_valid" CHECK ("agent_enrollment_tokens"."max_uses" > 0 AND "agent_enrollment_tokens"."uses" >= 0 AND "agent_enrollment_tokens"."uses" <= "agent_enrollment_tokens"."max_uses")
);
--> statement-breakpoint
ALTER TABLE "agent_enrollment_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_agent_id" uuid,
	"event_type" varchar(100) NOT NULL,
	"subject_type" varchar(80),
	"subject_id" varchar(160),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_event_type_nonempty" CHECK (length(btrim("audit_events"."event_type")) > 0),
	CONSTRAINT "audit_events_metadata_object" CHECK (jsonb_typeof("audit_events"."metadata") = 'object'),
	CONSTRAINT "audit_events_metadata_size" CHECK (octet_length("audit_events"."metadata"::text) <= 262144),
	CONSTRAINT "audit_events_actor_consistency" CHECK (
        (
          "audit_events"."actor_type" = 'user'
          AND "audit_events"."actor_user_id" IS NOT NULL
          AND "audit_events"."actor_agent_id" IS NULL
        )
        OR (
          "audit_events"."actor_type" = 'agent'
          AND "audit_events"."actor_user_id" IS NULL
          AND "audit_events"."actor_agent_id" IS NOT NULL
        )
        OR (
          "audit_events"."actor_type" = 'system'
          AND "audit_events"."actor_user_id" IS NULL
          AND "audit_events"."actor_agent_id" IS NULL
        )
      )
);
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "monitored_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"hostname" varchar(255) NOT NULL,
	"platform" varchar(40) NOT NULL,
	"architecture" varchar(40) NOT NULL,
	"agent_version" varchar(40),
	"status" "agent_status" DEFAULT 'pending' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"enrolled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitored_agents_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "monitored_agents_display_name_nonempty" CHECK (length(btrim("monitored_agents"."display_name")) > 0),
	CONSTRAINT "monitored_agents_hostname_nonempty" CHECK (length(btrim("monitored_agents"."hostname")) > 0),
	CONSTRAINT "monitored_agents_platform_nonempty" CHECK (length(btrim("monitored_agents"."platform")) > 0),
	CONSTRAINT "monitored_agents_architecture_nonempty" CHECK (length(btrim("monitored_agents"."architecture")) > 0)
);
--> statement-breakpoint
ALTER TABLE "monitored_agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"display_name" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_name_nonempty" CHECK (length(btrim("organizations"."name")) > 0),
	CONSTRAINT "organizations_slug_format" CHECK ("organizations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "telemetry_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"cpu_usage_percent" real,
	"memory_usage_percent" real,
	"disk_usage_percent" real,
	"network_receive_bytes_per_second" bigint,
	"network_transmit_bytes_per_second" bigint,
	"metrics" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_samples_cpu_range" CHECK ("telemetry_samples"."cpu_usage_percent" IS NULL OR ("telemetry_samples"."cpu_usage_percent" >= 0 AND "telemetry_samples"."cpu_usage_percent" <= 100)),
	CONSTRAINT "telemetry_samples_memory_range" CHECK ("telemetry_samples"."memory_usage_percent" IS NULL OR ("telemetry_samples"."memory_usage_percent" >= 0 AND "telemetry_samples"."memory_usage_percent" <= 100)),
	CONSTRAINT "telemetry_samples_disk_range" CHECK ("telemetry_samples"."disk_usage_percent" IS NULL OR ("telemetry_samples"."disk_usage_percent" >= 0 AND "telemetry_samples"."disk_usage_percent" <= 100)),
	CONSTRAINT "telemetry_samples_nonnegative_network" CHECK (
        ("telemetry_samples"."network_receive_bytes_per_second" IS NULL OR "telemetry_samples"."network_receive_bytes_per_second" >= 0)
        AND
        ("telemetry_samples"."network_transmit_bytes_per_second" IS NULL OR "telemetry_samples"."network_transmit_bytes_per_second" >= 0)
      ),
	CONSTRAINT "telemetry_samples_schema_version_positive" CHECK ("telemetry_samples"."schema_version" > 0),
	CONSTRAINT "telemetry_samples_metrics_object_and_size" CHECK (jsonb_typeof("telemetry_samples"."metrics") = 'object' AND octet_length("telemetry_samples"."metrics"::text) <= 262144)
);
--> statement-breakpoint
ALTER TABLE "telemetry_samples" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_provider" varchar(40) NOT NULL,
	"auth_subject" varchar(255) NOT NULL,
	"email" varchar(320),
	"email_verified_at" timestamp with time zone,
	"display_name" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_provider_nonempty" CHECK (length(btrim("users"."auth_provider")) > 0),
	CONSTRAINT "users_auth_subject_nonempty" CHECK (length(btrim("users"."auth_subject")) > 0)
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_tenant_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."monitored_agents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enrollment_tokens" ADD CONSTRAINT "agent_enrollment_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enrollment_tokens" ADD CONSTRAINT "agent_enrollment_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_agents" ADD CONSTRAINT "monitored_agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_samples" ADD CONSTRAINT "telemetry_samples_agent_tenant_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."monitored_agents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_token_hash_unique" ON "agent_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_credentials_agent_index" ON "agent_credentials" USING btree ("organization_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_enrollment_tokens_hash_unique" ON "agent_enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_enrollment_tokens_org_index" ON "agent_enrollment_tokens" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_time_index" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_event_index" ON "audit_events" USING btree ("organization_id","event_type");--> statement-breakpoint
CREATE INDEX "monitored_agents_org_status_index" ON "monitored_agents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "monitored_agents_org_last_seen_index" ON "monitored_agents" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "organization_memberships_user_index" ON "organization_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "telemetry_samples_org_agent_time_index" ON "telemetry_samples" USING btree ("organization_id","agent_id","recorded_at");--> statement-breakpoint
CREATE INDEX "telemetry_samples_org_time_index" ON "telemetry_samples" USING btree ("organization_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_identity_unique" ON "users" USING btree ("auth_provider","auth_subject");--> statement-breakpoint
CREATE INDEX "users_email_index" ON "users" USING btree ("email");--> statement-breakpoint
CREATE POLICY "audit_events_tenant_boundary" ON "audit_events" AS RESTRICTIVE FOR ALL TO public USING ("audit_events"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("audit_events"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_events_tenant_read" ON "audit_events" AS PERMISSIVE FOR SELECT TO public USING ("audit_events"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_events_tenant_insert" ON "audit_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("audit_events"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "monitored_agents_tenant_boundary" ON "monitored_agents" AS RESTRICTIVE FOR ALL TO public USING ("monitored_agents"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("monitored_agents"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "monitored_agents_tenant_read" ON "monitored_agents" AS PERMISSIVE FOR SELECT TO public USING ("monitored_agents"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_memberships_read_boundary" ON "organization_memberships" AS RESTRICTIVE FOR SELECT TO public USING (
        "organization_memberships"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
        OR "organization_memberships"."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      );--> statement-breakpoint
CREATE POLICY "organization_memberships_member_read" ON "organization_memberships" AS PERMISSIVE FOR SELECT TO public USING (
        "organization_memberships"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
        OR "organization_memberships"."user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      );--> statement-breakpoint
CREATE POLICY "organizations_tenant_boundary" ON "organizations" AS RESTRICTIVE FOR SELECT TO public USING ("organizations"."id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organizations_active_tenant_read" ON "organizations" AS PERMISSIVE FOR SELECT TO public USING ("organizations"."id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "telemetry_samples_tenant_boundary" ON "telemetry_samples" AS RESTRICTIVE FOR ALL TO public USING ("telemetry_samples"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("telemetry_samples"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "telemetry_samples_tenant_read" ON "telemetry_samples" AS PERMISSIVE FOR SELECT TO public USING ("telemetry_samples"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "telemetry_samples_tenant_insert" ON "telemetry_samples" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("telemetry_samples"."organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "users_self_boundary" ON "users" AS RESTRICTIVE FOR SELECT TO public USING ("users"."id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "users_self_read" ON "users" AS PERMISSIVE FOR SELECT TO public USING ("users"."id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "monitored_agents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_enrollment_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "telemetry_samples" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
