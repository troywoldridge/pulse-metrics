-- Pulse Metrics D15C-5A: REVIEW-ONLY bounded telemetry quota retention.
-- NEVER apply to ordinary development, staging, production or customer DBs.
-- The installation guard accepts ONLY the verified disposable PostgreSQL
-- Unix-socket cluster used by the project security rehearsals.
-- No scheduler is installed or enabled. No customer telemetry is deleted.
-- Fixed retention: expiry timestamp older than 48 hours.
-- Fixed per-call cap: at most 250 NETWORK + 250 AGENT quota rows.
\set ON_ERROR_STOP on
BEGIN;

DO $preflight$
DECLARE
  v_function_sha text;
BEGIN
  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('listen_addresses') <> ''
     OR current_setting('port') <> '55432'
     OR current_setting('data_directory') !~
          '^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'
     OR current_setting('unix_socket_directories') !~
          '^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$'
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5A: disposable PostgreSQL required'
      USING ERRCODE = '42501';
  END IF;

  IF to_regnamespace('pulse_telemetry_maintenance') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname = 'pulse_metrics_telemetry_maintenance_executor'
     )
     OR to_regclass('public.__drizzle_migrations') IS NULL
     OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_quota.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_quota.network_buckets') IS NULL
     OR to_regclass('pulse_telemetry_agent_quota.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_agent_quota.agent_buckets') IS NULL
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5A: protected quota baseline missing or replay'
      USING ERRCODE = '42501';
  END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pulse_telemetry_quota.schema_migrations
       WHERE version = '0001'
     )
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations
       WHERE version = '0001'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations
       WHERE version = '0002'
     )
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5A: unexpected quota migration receipts'
      USING ERRCODE = '42501';
  END IF;

  -- Refuse drift in the installed credential-authenticated ingestion function.
  SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex'
    ) INTO v_function_sha
  FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure(
     'pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'
  )
    AND p.prosecdef
    AND p.proowner = 'pulse_metrics_telemetry_executor'::regrole
    AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF v_function_sha IS DISTINCT FROM
       '04abf246ad3c10b3352c2cc52165a70c5f736d2280452bb4e0c02d84e04774e2'
     OR has_table_privilege(
       'pulse_metrics_app', 'public.agent_credentials', 'SELECT'
     )
     OR has_any_column_privilege(
       'pulse_metrics_app', 'public.telemetry_samples', 'INSERT'
     )
     OR has_any_column_privilege(
       'pulse_metrics_app', 'pulse_telemetry_quota.network_buckets', 'SELECT'
     )
     OR has_table_privilege(
       'pulse_metrics_app', 'pulse_telemetry_quota.network_buckets', 'DELETE'
     )
     OR has_any_column_privilege(
       'pulse_metrics_app', 'pulse_telemetry_agent_quota.agent_buckets', 'SELECT'
     )
     OR has_table_privilege(
       'pulse_metrics_app', 'pulse_telemetry_agent_quota.agent_buckets', 'DELETE'
     )
     OR has_schema_privilege(
       'pulse_metrics_app', 'pulse_telemetry_agent_quota', 'USAGE'
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_class
       WHERE oid IN (
         'pulse_telemetry_quota.network_buckets'::regclass,
         'pulse_telemetry_agent_quota.agent_buckets'::regclass
       )
         AND NOT (relrowsecurity AND relforcerowsecurity
                  AND relowner = 'postgres'::regrole)
     )
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5A: quota function or security drift'
      USING ERRCODE = '42501';
  END IF;
END;
$preflight$;

-- Private receipt and maintenance function. No application schema usage.
CREATE SCHEMA pulse_telemetry_maintenance;
REVOKE ALL ON SCHEMA pulse_telemetry_maintenance
  FROM PUBLIC, pulse_metrics_app;

CREATE TABLE pulse_telemetry_maintenance.schema_migrations (
  version varchar(16) PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  description varchar(160) NOT NULL
);
ALTER TABLE pulse_telemetry_maintenance.schema_migrations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_telemetry_maintenance.schema_migrations
  FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pulse_telemetry_maintenance.schema_migrations
  FROM PUBLIC, pulse_metrics_app;

-- No login; BYPASSRLS only applies where narrow table grants are present.
-- Never grant role membership to the runtime application role.
CREATE ROLE pulse_metrics_telemetry_maintenance_executor
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION BYPASSRLS;

GRANT USAGE ON SCHEMA pulse_telemetry_maintenance,
                      pulse_telemetry_quota,
                      pulse_telemetry_agent_quota
  TO pulse_metrics_telemetry_maintenance_executor;
GRANT SELECT (bucket_digest, window_end)
  ON pulse_telemetry_quota.network_buckets
  TO pulse_metrics_telemetry_maintenance_executor;
GRANT DELETE ON pulse_telemetry_quota.network_buckets
  TO pulse_metrics_telemetry_maintenance_executor;
-- PostgreSQL FOR UPDATE SKIP LOCKED also requires UPDATE on a column.
GRANT UPDATE (window_end) ON pulse_telemetry_quota.network_buckets
  TO pulse_metrics_telemetry_maintenance_executor;
GRANT SELECT (organization_id, agent_id, window_end)
  ON pulse_telemetry_agent_quota.agent_buckets
  TO pulse_metrics_telemetry_maintenance_executor;
GRANT DELETE ON pulse_telemetry_agent_quota.agent_buckets
  TO pulse_metrics_telemetry_maintenance_executor;
GRANT UPDATE (window_end) ON pulse_telemetry_agent_quota.agent_buckets
  TO pulse_metrics_telemetry_maintenance_executor;

-- This is a privileged, manually invoked operation, NOT a request handler.
-- Caller chooses no cutoff, tenant, network key, agent ID, batch size, or clock.
-- SKIP LOCKED avoids contending with active quota UPSERT transactions.
-- Recheck expiry during DELETE so a freshly renewed bucket survives.
-- Both table deletions are atomic within the invoking SQL transaction.
CREATE FUNCTION pulse_telemetry_maintenance.prune_expired_quota_buckets()
RETURNS TABLE (network_removed integer, agent_removed integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $maintenance$
DECLARE
  v_cutoff timestamptz := clock_timestamp() - interval '48 hours';
  v_network integer;
  v_agent integer;
BEGIN
  WITH candidates AS (
    SELECT b.bucket_digest
    FROM pulse_telemetry_quota.network_buckets b
    WHERE b.window_end < v_cutoff
    ORDER BY b.window_end, b.bucket_digest
    LIMIT 250
    FOR UPDATE OF b SKIP LOCKED
  ), removed AS (
    DELETE FROM pulse_telemetry_quota.network_buckets b
    USING candidates c
    WHERE b.bucket_digest = c.bucket_digest
      AND b.window_end < v_cutoff
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_network FROM removed;

  WITH candidates AS (
    SELECT b.organization_id, b.agent_id
    FROM pulse_telemetry_agent_quota.agent_buckets b
    WHERE b.window_end < v_cutoff
    ORDER BY b.window_end, b.organization_id, b.agent_id
    LIMIT 250
    FOR UPDATE OF b SKIP LOCKED
  ), removed AS (
    DELETE FROM pulse_telemetry_agent_quota.agent_buckets b
    USING candidates c
    WHERE b.organization_id = c.organization_id
      AND b.agent_id = c.agent_id
      AND b.window_end < v_cutoff
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_agent FROM removed;

  network_removed := v_network;
  agent_removed := v_agent;
  RETURN NEXT;
END;
$maintenance$;

ALTER FUNCTION pulse_telemetry_maintenance.prune_expired_quota_buckets()
  OWNER TO pulse_metrics_telemetry_maintenance_executor;
REVOKE ALL ON FUNCTION
  pulse_telemetry_maintenance.prune_expired_quota_buckets()
  FROM PUBLIC, pulse_metrics_app;
-- postgres superuser is the only approved test caller at this stage.
-- No login maintenance operator or automatic scheduler is created.
GRANT EXECUTE ON FUNCTION
  pulse_telemetry_maintenance.prune_expired_quota_buckets()
  TO postgres;

DO $postflight$
DECLARE
  v_executor record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls, rolinherit
    INTO v_executor
  FROM pg_catalog.pg_roles
  WHERE rolname = 'pulse_metrics_telemetry_maintenance_executor';

  IF NOT FOUND OR v_executor.rolcanlogin OR v_executor.rolsuper
     OR v_executor.rolcreatedb OR v_executor.rolcreaterole
     OR v_executor.rolreplication OR NOT v_executor.rolbypassrls
     OR v_executor.rolinherit
     OR has_schema_privilege(
       'pulse_metrics_app', 'pulse_telemetry_maintenance', 'USAGE'
     )
     OR has_function_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_maintenance.prune_expired_quota_buckets()', 'EXECUTE'
     )
     OR has_table_privilege(
       'pulse_metrics_app', 'pulse_telemetry_quota.network_buckets', 'DELETE'
     )
     OR has_table_privilege(
       'pulse_metrics_app', 'pulse_telemetry_agent_quota.agent_buckets', 'DELETE'
     )
     OR pg_has_role(
       'pulse_metrics_app', 'pulse_metrics_telemetry_maintenance_executor', 'MEMBER'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid =
         'pulse_telemetry_maintenance.prune_expired_quota_buckets()'::regprocedure
         AND p.prosecdef
         AND p.proowner =
             'pulse_metrics_telemetry_maintenance_executor'::regrole
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) a
       WHERE p.oid =
         'pulse_telemetry_maintenance.prune_expired_quota_buckets()'::regprocedure
         AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5A: maintenance privilege invariant failed'
      USING ERRCODE = '42501';
  END IF;
END;
$postflight$;

INSERT INTO pulse_telemetry_maintenance.schema_migrations(version, description)
VALUES ('0001', 'D15C-5A bounded telemetry quota retention rehearsal');

COMMIT;
