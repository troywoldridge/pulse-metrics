-- Pulse Metrics D15B: release permission gate.
--
-- READ ONLY.
-- Intended for post-migration, upgrade and recovery verification.
-- Does not create, revoke, or repair permissions.
--
-- Execute with psql -X -v ON_ERROR_STOP=1 against the
-- intended database using an authorized audit connection.

\set ON_ERROR_STOP on

BEGIN READ ONLY;

DO $gate$
DECLARE
  v_function oid;
BEGIN
  IF current_database() <> 'pulse_metrics' THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: unexpected database';
  END IF;

  IF to_regclass('public.telemetry_samples') IS NULL
     OR to_regclass('public.agent_credentials') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.submissions') IS NULL
  THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: required tables missing';
  END IF;

  v_function := to_regprocedure(
    'pulse_telemetry_ingestion.ingest_submission(
      text,uuid,text,timestamptz,integer,
      real,real,real,bigint,bigint,jsonb
    )'
  );

  IF v_function IS NULL THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: ingestion function missing';
  END IF;

  -- Require exactly one protected atomic installation receipt.
  IF to_regclass(
       'pulse_telemetry_ingestion.schema_migrations'
     ) IS NULL THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: installation receipt missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid =
      'pulse_telemetry_ingestion.schema_migrations'::regclass
      AND relowner = 'postgres'::regrole
      AND relrowsecurity
      AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: installation receipt unprotected';
  END IF;

  IF has_table_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_ingestion.schema_migrations',
       'SELECT'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_ingestion.schema_migrations',
       'INSERT'
     ) THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: runtime can access installation receipts';
  END IF;

  IF (
    SELECT count(*)
    FROM pulse_telemetry_ingestion.schema_migrations
  ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pulse_telemetry_ingestion.schema_migrations
       WHERE version = '0001'
         AND description =
           'Credential-authenticated telemetry ingestion, revision 1'
     ) THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: installation receipt mismatch';
  END IF;

  -- Direct telemetry writes must never be available
  -- to the ordinary application role.
  IF has_any_column_privilege(
       'pulse_metrics_app',
       'public.telemetry_samples',
       'INSERT'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'public.telemetry_samples',
       'UPDATE'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'public.telemetry_samples',
       'DELETE'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'public.telemetry_samples',
       'TRUNCATE'
     )
  THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: unsafe telemetry application grants';
  END IF;

  IF has_table_privilege(
       'pulse_metrics_app',
       'public.agent_credentials',
       'SELECT'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_ingestion.submissions',
       'SELECT'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_ingestion.submissions',
       'INSERT'
     )
  THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: protected credential or receipt access';
  END IF;

  IF pg_has_role(
       'pulse_metrics_app',
       'pulse_metrics_telemetry_executor',
       'MEMBER'
     ) THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: executor role membership';
  END IF;

  IF NOT has_function_privilege(
       'pulse_metrics_app',
       v_function,
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: authenticated ingestion unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = v_function
      AND (
        NOT p.prosecdef
        OR p.proowner <>
          'pulse_metrics_telemetry_executor'::regrole
        OR NOT EXISTS (
          SELECT 1
          FROM unnest(p.proconfig) setting
          WHERE regexp_replace(
            setting, '[[:space:]]', '', 'g'
          ) = 'search_path=pg_catalog,pg_temp'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: ingestion function security changed';
  END IF;

  IF has_function_privilege(
       'public',
       v_function,
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: public ingestion execution';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid =
      'pulse_telemetry_ingestion.submissions'::regclass
      AND relrowsecurity
      AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION
      'D15B_RELEASE_NO_GO: receipt ledger RLS disabled';
  END IF;

  RAISE NOTICE
    'PASS: D15B release telemetry permissions verified';
END;
$gate$;

COMMIT;
