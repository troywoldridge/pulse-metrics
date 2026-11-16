-- Pulse Metrics D15C-5U-2F2F: independently reviewed READ-ONLY nonzero
-- telemetry audit. DISPOSABLE test cluster ONLY, not a migration or service.
-- psql variables org_a and org_b must be validated by the wrapper first.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT set_config('pulse_audit.org_a', :'org_a', true),
       set_config('pulse_audit.org_b', :'org_b', true);
DO $audit$
DECLARE
  org_a uuid := current_setting('pulse_audit.org_a')::uuid;
  org_b uuid := current_setting('pulse_audit.org_b')::uuid;
  a_agent uuid;
  b_agent uuid;
BEGIN
  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres'
     OR current_setting('transaction_read_only') <> 'on'
     OR current_setting('port') <> '55432'
     OR current_setting('listen_addresses') <> ''
     OR current_setting('data_directory') !~ '^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'
     OR current_setting('unix_socket_directories') <> regexp_replace(current_setting('data_directory'), '/data$', '/socket')
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
     OR org_a = org_b
  THEN RAISE EXCEPTION '2F2F: unsafe or unexpected disposable database identity'; END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps WHERE recorded_mode='fresh_replay') <> 6
     OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0002')
  THEN RAISE EXCEPTION '2F2F: migration receipts differ from tested baseline'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('pulse_metrics_app', 'pulse_metrics_migrator')
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit)
  )
    OR has_table_privilege('pulse_metrics_app', 'public.agent_credentials', 'SELECT')
    OR has_any_column_privilege('pulse_metrics_app', 'public.telemetry_samples', 'INSERT')
    OR has_table_privilege('pulse_metrics_app', 'pulse_telemetry_ingestion.submissions', 'SELECT')
    OR has_schema_privilege('pulse_metrics_app', 'pulse_telemetry_agent_quota', 'USAGE')
  THEN RAISE EXCEPTION '2F2F: least-privilege boundary regressed'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND ((n.nspname = 'public' AND c.relname IN
           ('agent_credentials', 'monitored_agents', 'telemetry_samples', 'organization_memberships'))
        OR (n.nspname IN ('pulse_telemetry_ingestion', 'pulse_telemetry_quota', 'pulse_telemetry_agent_quota')
            AND c.relname IN ('submissions', 'network_buckets', 'agent_buckets')))
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  ) THEN RAISE EXCEPTION '2F2F: FORCE RLS regressed'; END IF;

  IF (SELECT count(*) FROM public.telemetry_samples) <> 246
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 246
     OR (SELECT count(*) FROM public.telemetry_samples WHERE metrics ? 'memory.total_bytes') <> 2
  THEN RAISE EXCEPTION '2F2F: unexpected nonzero telemetry inventory'; END IF;

  -- An FK only establishes submission->sample existence. Prove the reverse,
  -- exact one-to-one ownership, and prevent privileged orphan inserts.
  IF EXISTS (
    SELECT 1 FROM public.telemetry_samples t
    LEFT JOIN pulse_telemetry_ingestion.submissions s
      ON s.telemetry_sample_id = t.id
    WHERE s.telemetry_sample_id IS NULL
       OR t.organization_id IS DISTINCT FROM s.organization_id
       OR t.agent_id IS DISTINCT FROM s.agent_id
  ) THEN RAISE EXCEPTION '2F2F: orphaned or mismatched telemetry submission'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.telemetry_samples t
    LEFT JOIN public.monitored_agents a
      ON a.organization_id = t.organization_id AND a.id = t.agent_id
    WHERE a.id IS NULL OR t.organization_id NOT IN (org_a, org_b)
  ) THEN RAISE EXCEPTION '2F2F: unexpected telemetry tenant or agent'; END IF;

  SELECT id INTO a_agent FROM public.monitored_agents
    WHERE organization_id = org_a AND hostname = 'd15c5t-a.invalid' AND status = 'revoked';
  SELECT id INTO b_agent FROM public.monitored_agents
    WHERE organization_id = org_b AND hostname = 'd15c5t-b.invalid' AND status = 'active';
  IF a_agent IS NULL OR b_agent IS NULL OR a_agent = b_agent
     OR (SELECT count(*) FROM public.monitored_agents WHERE organization_id=org_a AND hostname='d15c5t-a.invalid') <> 1
     OR (SELECT count(*) FROM public.monitored_agents WHERE organization_id=org_b AND hostname='d15c5t-b.invalid') <> 1
  THEN RAISE EXCEPTION '2F2F: pilot agent identity or state incorrect'; END IF;

  IF (SELECT count(*) FROM public.telemetry_samples WHERE organization_id=org_a AND agent_id=a_agent AND metrics ? 'memory.total_bytes') <> 1
     OR (SELECT count(*) FROM public.telemetry_samples WHERE organization_id=org_b AND agent_id=b_agent AND metrics ? 'memory.total_bytes') <> 1
     OR EXISTS (
       SELECT 1 FROM public.telemetry_samples
       WHERE metrics ? 'memory.total_bytes'
         AND NOT ((organization_id=org_a AND agent_id=a_agent)
           OR (organization_id=org_b AND agent_id=b_agent))
     )
  THEN RAISE EXCEPTION '2F2F: genuine Linux telemetry not bound to exact agents'; END IF;

  IF (SELECT count(*) FROM public.agent_credentials WHERE organization_id=org_a AND agent_id=a_agent) <> 1
     OR (SELECT count(*) FROM public.agent_credentials WHERE organization_id=org_b AND agent_id=b_agent) <> 1
     OR EXISTS (
       SELECT 1 FROM public.agent_credentials c
       WHERE (c.organization_id=org_a AND c.agent_id=a_agent AND c.revoked_at IS NULL)
          OR (c.organization_id=org_b AND c.agent_id=b_agent AND c.revoked_at IS NOT NULL)
          OR (c.organization_id IN (org_a, org_b)
              AND (c.scopes IS DISTINCT FROM '["telemetry:write"]'::jsonb
                   OR c.token_hash !~ '^[0-9a-f]{64}$'))
     )
  THEN RAISE EXCEPTION '2F2F: revoked/active machine credential contract changed'; END IF;

  RAISE NOTICE 'PASS: 2F2F nonzero rows, exact submission ledger and agent ownership audited read-only';
  RAISE NOTICE 'PASS: 2F2F FORCE RLS, credentials and least-privilege protections retained';
END;
$audit$;
COMMIT;
