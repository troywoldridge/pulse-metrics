-- Pulse Metrics D15C-5U-2F2H — read-only, owner-verified live inventory.
-- This SQL is ONLY for the stopped-and-then-guardedly-started quarantined
-- PostgreSQL cluster at the exact private path/Unix socket/port below.
-- Does not install objects, generate credentials, change session configuration
-- outside a read-only transaction, enroll agents, or authorize telemetry writes.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

DO $identity$
BEGIN
  IF current_database() <> 'pulse_metrics'
    OR current_user <> 'postgres'
    OR current_setting('transaction_read_only') <> 'on'
    OR current_setting('data_directory') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
    OR current_setting('unix_socket_directories') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/socket'
    OR current_setting('port') <> '55433'
    OR current_setting('listen_addresses') <> ''
    OR inet_server_addr() IS NOT NULL
    OR inet_server_port() IS NOT NULL
  THEN RAISE EXCEPTION 'REFUSE_2F2H: database identity or read-only boundary invalid'; END IF;

  IF to_regclass('public.__drizzle_migrations') IS NULL
    OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
    OR to_regclass('pulse_agent_enrollment.schema_migrations') IS NULL
    OR to_regclass('pulse_telemetry_ingestion.schema_migrations') IS NULL
    OR to_regclass('pulse_telemetry_ingestion.submissions') IS NULL
    OR to_regclass('pulse_telemetry_quota.schema_migrations') IS NULL
    OR to_regclass('pulse_telemetry_agent_quota.schema_migrations') IS NULL
  THEN RAISE EXCEPTION 'REFUSE_2F2H: missing reviewed database objects'; END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps
         WHERE recorded_mode='fresh_replay') <> 6
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 1
    OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
    OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
    OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
    OR NOT EXISTS (
         SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0002'
       )
  THEN RAISE EXCEPTION 'REFUSE_2F2H: reviewed migration receipts changed'; END IF;

  -- This first live-adapter rehearsal is EMPTY-ONLY. A future bounded-data
  -- authorization may not reuse this zero-row gate or relax it by environment.
  IF EXISTS (SELECT 1 FROM public.users)
    OR EXISTS (SELECT 1 FROM public.organizations)
    OR EXISTS (SELECT 1 FROM public.organization_memberships)
    OR EXISTS (SELECT 1 FROM public.monitored_agents)
    OR EXISTS (SELECT 1 FROM public.agent_credentials)
    OR EXISTS (SELECT 1 FROM public.agent_enrollment_tokens)
    OR EXISTS (SELECT 1 FROM public.organization_invitations)
    OR EXISTS (SELECT 1 FROM public.invitation_rate_limits)
    OR EXISTS (SELECT 1 FROM public.audit_events)
    OR EXISTS (SELECT 1 FROM public.telemetry_samples)
    OR EXISTS (SELECT 1 FROM pulse_telemetry_ingestion.submissions)
    OR EXISTS (SELECT 1 FROM pulse_telemetry_quota.network_buckets)
    OR EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.agent_buckets)
  THEN RAISE EXCEPTION 'REFUSE_2F2H: nonempty database is NOT authorized by this adapter'; END IF;
END;
$identity$;

-- Actual forced-RLS test using the real ordinary application role; the
-- transaction-scoped role switch is reset immediately afterwards.
SET LOCAL ROLE pulse_metrics_app;
SELECT count(*)::text AS unscoped_visible FROM public.telemetry_samples \gset
RESET ROLE;

DO $role_reset$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR current_setting('transaction_read_only') <> 'on'
  THEN RAISE EXCEPTION 'REFUSE_2F2H: privileged audit role not restored'; END IF;
END;
$role_reset$;

-- Only nonsecret inventory fields. Exactly one JSON record is emitted.
-- PostgreSQL snapshot and the effective RLS probe share one REPEATABLE READ
-- transaction. Runtime credential grants are introspected, not exercised.
SELECT jsonb_build_object(
  'version', 1,
  'organizationIds', COALESCE(
    (SELECT jsonb_agg(o.id::text ORDER BY o.id) FROM public.organizations o), '[]'::jsonb),
  'userCount', (SELECT count(*) FROM public.users),
  'membershipCount', (SELECT count(*) FROM public.organization_memberships),
  'agents', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
      'organizationId', a.organization_id::text,
      'agentId', a.id::text,
      'status', a.status::text
    ) ORDER BY a.organization_id, a.id) FROM public.monitored_agents a), '[]'::jsonb),
  'credentials', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
      'organizationId', c.organization_id::text,
      'agentId', c.agent_id::text,
      'revoked', c.revoked_at IS NOT NULL,
      'scopes', c.scopes
    ) ORDER BY c.organization_id, c.agent_id)
       FROM public.agent_credentials c), '[]'::jsonb),
  'sampleCount', (SELECT count(*) FROM public.telemetry_samples),
  'submissionCount', (SELECT count(*) FROM pulse_telemetry_ingestion.submissions),
  'samplesByAgent', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
      'organizationId', x.organization_id::text,
      'agentId', x.agent_id::text,
      'count', x.samples
    ) ORDER BY x.organization_id, x.agent_id)
    FROM (SELECT organization_id, agent_id, count(*) AS samples
          FROM public.telemetry_samples GROUP BY organization_id, agent_id) x), '[]'::jsonb),
  'orphanSamples', (SELECT count(*) FROM public.telemetry_samples t
    LEFT JOIN pulse_telemetry_ingestion.submissions s ON s.telemetry_sample_id=t.id
    WHERE s.telemetry_sample_id IS NULL),
  'mismatchedLedger', (SELECT count(*) FROM pulse_telemetry_ingestion.submissions s
    LEFT JOIN public.telemetry_samples t ON t.id=s.telemetry_sample_id
    WHERE t.id IS NULL OR s.organization_id IS DISTINCT FROM t.organization_id
      OR s.agent_id IS DISTINCT FROM t.agent_id),
  'unownedTelemetry', (SELECT count(*) FROM public.telemetry_samples t
    LEFT JOIN public.monitored_agents a
      ON a.id=t.agent_id AND a.organization_id=t.organization_id
    WHERE a.id IS NULL),
  'unscopedVisibleSamples', :'unscoped_visible'::bigint,
  'rlsViolations', (SELECT count(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND
       ((n.nspname='public' AND c.relname IN (
         'organizations','users','organization_memberships',
         'monitored_agents','agent_credentials','agent_enrollment_tokens',
         'organization_invitations','invitation_rate_limits',
         'telemetry_samples','audit_events'))
        OR (n.nspname IN ('pulse_telemetry_ingestion','pulse_telemetry_quota',
          'pulse_telemetry_agent_quota') AND c.relname IN (
          'submissions','network_buckets','agent_buckets')))
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity)),
  'unsafeRoles', (SELECT count(*) FROM pg_roles
    WHERE rolname IN ('pulse_metrics_app','pulse_metrics_migrator')
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)),
  'migrationReceiptErrors', CASE WHEN
       (SELECT count(*) FROM public.__drizzle_migrations) = 1
       AND (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) = 6
       AND (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps
            WHERE recorded_mode='fresh_replay') = 6
       AND (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) = 1
       AND (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) = 1
       AND (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) = 1
       AND (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) = 2
       THEN 0 ELSE 1 END,
  'runtimeCredentialRead',
       has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
       OR has_any_column_privilege('pulse_metrics_app','public.agent_credentials','SELECT'),
  'runtimeDirectTelemetryInsert',
       has_table_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
       OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
)::text;
COMMIT;
