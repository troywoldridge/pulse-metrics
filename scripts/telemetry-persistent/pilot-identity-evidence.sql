-- D15C-5U-2F2J — candidate read-only identity/membership audit, DISPOSABLE ONLY.
-- Operator runs this on an ALREADY RUNNING test cluster: exact local Unix
-- socket /tmp/pulse-replay-XXXXXXXXXX/socket, port 55432, TCP disabled.
-- No 55433 target, no source cluster writes, no migrations, no credential hashes.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

DO $boundary$
BEGIN
  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres' OR session_user <> 'postgres'
     OR current_setting('transaction_read_only') <> 'on'
     OR current_setting('server_version_num')::integer < 160000
     OR current_setting('server_version_num')::integer >= 170000
     OR current_setting('port') <> '55432'
     OR current_setting('listen_addresses') <> ''
     OR current_setting('data_directory') !~ '^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'
     OR current_setting('unix_socket_directories') <>
       regexp_replace(current_setting('data_directory'), '/data$', '/socket')
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2F2J: invalid disposable read-only database identity'; END IF;

  IF to_regclass('public.__drizzle_migrations') IS NULL
     OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
     OR to_regclass('pulse_agent_enrollment.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.submissions') IS NULL
     OR to_regclass('pulse_telemetry_quota.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_agent_quota.schema_migrations') IS NULL
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2F2J: required migration schema missing'; END IF;

  -- A pure identity preflight: exactly one user/organization/membership/
  -- agent/credential, and no samples. Telemetry policy is NOT relaxed.
  IF (SELECT count(*) FROM public.users) <> 1
     OR (SELECT count(*) FROM public.organizations) <> 1
     OR (SELECT count(*) FROM public.organization_memberships) <> 1
     OR (SELECT count(*) FROM public.monitored_agents) <> 1
     OR (SELECT count(*) FROM public.agent_credentials) <> 1
     OR EXISTS (SELECT 1 FROM public.telemetry_samples)
     OR EXISTS (SELECT 1 FROM pulse_telemetry_ingestion.submissions)
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2F2J: not a one-owner pre-telemetry pilot'; END IF;
END;
$boundary$;

-- This is an EFFECTIVE unscoped read under the ordinary application role,
-- not only an inspection of pg_catalog RLS flags.
SET LOCAL ROLE pulse_metrics_app;
SELECT count(*)::text AS visible_unscoped FROM public.telemetry_samples \gset
RESET ROLE;
DO $reset$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR current_setting('transaction_read_only') <> 'on'
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2F2J: role reset or read-only boundary failed'; END IF;
END;
$reset$;

-- Emits one bounded, NONSECRET JSONB row. Owner membership is checked by
-- direct foreign-key identity equality; WorkOS provider authentication is
-- independent and NOT proved by this SQL.
SELECT jsonb_build_object(
  'version', 1,
  'source', 'pulse-metrics/2f2j/disposable-read-only-identity-v1',
  'target', jsonb_build_object(
    'database', 'pulse_metrics',
    'port', 55432,
    'transport', 'private-unix-socket-no-tcp',
    'dataDirectoryClass', 'disposable-pulse-replay'),
  'organizations', (SELECT jsonb_agg(jsonb_build_object('id', o.id::text))
    FROM public.organizations o),
  'users', (SELECT jsonb_agg(jsonb_build_object('id', u.id::text))
    FROM public.users u),
  'memberships', (SELECT jsonb_agg(jsonb_build_object(
    'organizationId', m.organization_id::text,
    'userId', m.user_id::text,
    'role', m.role::text)) FROM public.organization_memberships m),
  'agents', (SELECT jsonb_agg(jsonb_build_object(
    'organizationId', a.organization_id::text,
    'agentId', a.id::text,
    'status', a.status::text)) FROM public.monitored_agents a),
  'credentials', (SELECT jsonb_agg(jsonb_build_object(
    'organizationId', c.organization_id::text,
    'agentId', c.agent_id::text,
    'revoked', c.revoked_at IS NOT NULL,
    'scopes', c.scopes)) FROM public.agent_credentials c),
  'sampleCount', (SELECT count(*) FROM public.telemetry_samples),
  'submissionCount', (SELECT count(*) FROM pulse_telemetry_ingestion.submissions),
  'security', jsonb_build_object(
    'unscopedVisibleSamples', :'visible_unscoped'::bigint,
    'rlsViolations', (SELECT count(*) FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND ((n.nspname='public' AND c.relname IN (
          'organizations','users','organization_memberships','monitored_agents',
          'agent_credentials','agent_enrollment_tokens', 'telemetry_samples',
          'organization_invitations','invitation_rate_limits','audit_events'))
        OR (n.nspname IN ('pulse_telemetry_ingestion','pulse_telemetry_quota',
          'pulse_telemetry_agent_quota') AND c.relname IN (
          'submissions','network_buckets','agent_buckets')))
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)),
    'unsafeRoles', (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('pulse_metrics_app','pulse_metrics_migrator')
        AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)),
    'migrationReceiptErrors', CASE WHEN
      (SELECT count(*) FROM public.__drizzle_migrations)=1
      AND (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)=6
      AND (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps
           WHERE recorded_mode='fresh_replay')=6
      AND (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations)=1
      AND (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations)=1
      AND (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations)=1
      AND (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations)=2
      AND EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations
                  WHERE version='0002')
      THEN 0 ELSE 1 END,
    'runtimeCredentialRead',
      has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
      OR has_any_column_privilege('pulse_metrics_app','public.agent_credentials','SELECT'),
    'runtimeDirectTelemetryInsert',
      has_table_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
      OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
  )
)::text;
COMMIT;
