-- D15C-5U-2F2K: synthetic one-owner pretelemetry fixture, DISPOSABLE ONLY.
-- Deliberately not a migration, not a persistent pilot, not live agent enrollment.
-- The sole caller is the pinned D15C-4B disposable cluster prefix at port 55432.
\set ON_ERROR_STOP on
BEGIN;
DO $boundary$
BEGIN
  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres' OR session_user <> 'postgres'
     OR current_setting('server_version_num')::integer < 160000
     OR current_setting('server_version_num')::integer >= 170000
     OR current_setting('port') <> '55432'
     OR current_setting('listen_addresses') <> ''
     OR current_setting('data_directory') !~ '^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'
     OR current_setting('unix_socket_directories') <>
        regexp_replace(current_setting('data_directory'), '/data$', '/socket')
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5U2F2K: disposable PostgreSQL target mismatch';
  END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps
            WHERE recorded_mode='fresh_replay') <> 6
     OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations
                    WHERE version='0002')
     OR (SELECT count(*) FROM public.users) <> 0
     OR (SELECT count(*) FROM public.organizations) <> 0
     OR (SELECT count(*) FROM public.organization_memberships) <> 0
     OR (SELECT count(*) FROM public.monitored_agents) <> 0
     OR (SELECT count(*) FROM public.agent_credentials) <> 0
     OR (SELECT count(*) FROM public.agent_enrollment_tokens) <> 0
     OR (SELECT count(*) FROM public.audit_events) <> 0
     OR (SELECT count(*) FROM public.telemetry_samples) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_quota.network_buckets) <> 3
     OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR has_any_column_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR has_table_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
     OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
     OR EXISTS (SELECT 1 FROM pg_class c
                 WHERE c.oid IN ('public.users'::regclass,
                      'public.organizations'::regclass,
                      'public.organization_memberships'::regclass,
                      'public.monitored_agents'::regclass,
                      'public.agent_credentials'::regclass,
                      'public.telemetry_samples'::regclass)
                   AND NOT (c.relrowsecurity AND c.relforcerowsecurity))
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5U2F2K: baseline receipts, empty inventory, quota or privileges invalid';
  END IF;
END;
$boundary$;

-- Only synthetic identity data. There is no enrollment token or useful secret.
-- The random value hashed below is discarded; no operator can redeem it.
DO $synthetic$
BEGIN
  PERFORM public.resolve_workos_user('user_d15c5u2f2k_synthetic_only');
  PERFORM * FROM public.create_workos_organization(
    'user_d15c5u2f2k_synthetic_only',
    'D15C5U2F2K Synthetic Disposable Organization',
    'pulse-d15c5u2f2k-disposable'
  );
END;
$synthetic$;

WITH added_agent AS (
  INSERT INTO public.monitored_agents
    (organization_id,display_name,hostname,platform,architecture,status,enrolled_at)
  SELECT id,'2F2K Synthetic Agent','synthetic-2f2k.invalid',
         'linux','x86_64','active',clock_timestamp()
  FROM public.organizations
  WHERE slug='pulse-d15c5u2f2k-disposable'
  RETURNING id,organization_id
)
INSERT INTO public.agent_credentials
  (organization_id,agent_id,token_prefix,token_hash,scopes,expires_at)
SELECT a.organization_id,a.id,left(h.digest,12),h.digest,
       '["telemetry:write"]'::jsonb,clock_timestamp()+interval '30 days'
FROM added_agent a
CROSS JOIN LATERAL (
  SELECT encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex') AS digest
) h;

DO $verify$
BEGIN
  IF (SELECT count(*) FROM public.users) <> 1
     OR (SELECT count(*) FROM public.organizations) <> 1
     OR (SELECT count(*) FROM public.organization_memberships) <> 1
     OR (SELECT count(*) FROM public.monitored_agents) <> 1
     OR (SELECT count(*) FROM public.agent_credentials) <> 1
     OR (SELECT count(*) FROM public.organization_memberships
            WHERE role='owner') <> 1
     OR (SELECT count(*) FROM public.monitored_agents
            WHERE status='active') <> 1
     OR (SELECT count(*) FROM public.agent_credentials
            WHERE revoked_at IS NULL
              AND scopes='["telemetry:write"]'::jsonb) <> 1
     OR EXISTS (SELECT 1 FROM public.telemetry_samples)
     OR EXISTS (SELECT 1 FROM pulse_telemetry_ingestion.submissions)
     OR EXISTS (SELECT 1 FROM public.agent_enrollment_tokens)
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5U2F2K: synthetic fixture violated one-owner identity';
  END IF;
END;
$verify$;
COMMIT;
