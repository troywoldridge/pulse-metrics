-- D15B security audit.
-- Execute only through the verified disposable cluster launcher.

\set ON_ERROR_STOP on

BEGIN READ ONLY;

DO $audit$
DECLARE
  r record;
BEGIN
  IF current_user <> 'postgres'
     OR current_database() <> 'pulse_metrics'
     OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe privilege audit connection';
  END IF;

  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls, rolinherit
  INTO r
  FROM pg_roles
  WHERE rolname = 'pulse_metrics_telemetry_executor';

  IF NOT FOUND
     OR r.rolcanlogin
     OR r.rolsuper
     OR r.rolcreatedb
     OR r.rolcreaterole
     OR r.rolreplication
     OR NOT r.rolbypassrls
     OR r.rolinherit THEN
    RAISE EXCEPTION 'Telemetry executor role attributes unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE roleid = 'pulse_metrics_telemetry_executor'::regrole
       OR member = 'pulse_metrics_telemetry_executor'::regrole
  ) THEN
    RAISE EXCEPTION 'Unexpected executor role membership';
  END IF;

  IF pg_has_role(
       'pulse_metrics_app',
       'pulse_metrics_telemetry_executor',
       'MEMBER'
     ) THEN
    RAISE EXCEPTION 'Application account can inherit executor role';
  END IF;

  -- Both table-level and column-level INSERT capabilities
  -- must be absent from the ordinary application role.
  IF has_any_column_privilege(
       'pulse_metrics_app',
       'public.telemetry_samples',
       'INSERT'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'public.agent_credentials',
       'SELECT'
     )
     OR has_column_privilege(
       'pulse_metrics_app',
       'public.agent_credentials',
       'revoked_at',
       'UPDATE'
     )
     OR has_column_privilege(
       'pulse_metrics_app',
       'public.monitored_agents',
       'status',
       'UPDATE'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_ingestion.submissions',
       'INSERT'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_ingestion.submissions',
       'SELECT'
     )
  THEN
    RAISE EXCEPTION 'Ordinary application role has elevated privileges';
  END IF;

  IF NOT has_column_privilege(
       'pulse_metrics_telemetry_executor',
       'public.agent_credentials',
       'revoked_at',
       'UPDATE'
     )
     OR NOT has_column_privilege(
       'pulse_metrics_telemetry_executor',
       'public.monitored_agents',
       'status',
       'UPDATE'
     )
     OR has_column_privilege(
       'pulse_metrics_telemetry_executor',
       'public.agent_credentials',
       'token_hash',
       'UPDATE'
     )
     OR has_column_privilege(
       'pulse_metrics_telemetry_executor',
       'public.agent_credentials',
       'scopes',
       'UPDATE'
     )
  THEN
    RAISE EXCEPTION 'Executor column permissions incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid =
      'pulse_telemetry_ingestion.ingest_submission(
        text,uuid,text,timestamptz,integer,
        real,real,real,bigint,bigint,jsonb
      )'::regprocedure
      AND p.prosecdef
      AND p.proowner = 'pulse_metrics_telemetry_executor'::regrole
      AND EXISTS (
        SELECT 1
        FROM unnest(p.proconfig) setting
        WHERE regexp_replace(setting, '[[:space:]]', '', 'g')
              = 'search_path=pg_catalog,pg_temp'
      )
  ) THEN
    RAISE EXCEPTION 'Security definer configuration incorrect';
  END IF;

  IF NOT has_function_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_ingestion.ingest_submission(
         text,uuid,text,timestamptz,integer,
         real,real,real,bigint,bigint,jsonb
       )',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Authorized app ingestion entry point unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL
      aclexplode(
        coalesce(p.proacl, acldefault('f', p.proowner))
      ) grant_entry
    WHERE p.pronamespace =
      'pulse_telemetry_ingestion'::regnamespace
      AND grant_entry.grantee = 0
      AND grant_entry.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can execute telemetry security functions';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid =
      'pulse_telemetry_ingestion.submissions'::regclass
      AND relrowsecurity
      AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Private submission ledger RLS not enforced';
  END IF;

  RAISE NOTICE 'PASS: D15B executor, grants, function and ledger audit';
END;
$audit$;

COMMIT;
