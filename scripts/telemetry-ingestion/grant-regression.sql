-- Pulse Metrics D15B
-- Legacy permission regression rehearsal.
-- Disposable PostgreSQL cluster ONLY.
-- All permission changes are rolled back.

\set ON_ERROR_STOP on

BEGIN;

DO $check$
BEGIN
  IF current_user <> 'postgres'
     OR current_database() <> 'pulse_metrics'
     OR inet_server_addr() IS NOT NULL
     OR to_regprocedure(
       'pulse_telemetry_ingestion.ingest_submission(
         text,uuid,text,timestamptz,integer,
         real,real,real,bigint,bigint,jsonb
       )'
     ) IS NULL
  THEN
    RAISE EXCEPTION 'Unsafe D15B regression test environment';
  END IF;

  IF has_any_column_privilege(
    'pulse_metrics_app',
    'public.telemetry_samples',
    'INSERT'
  ) THEN
    RAISE EXCEPTION
      'Application already has unauthorized INSERT privilege';
  END IF;

  RAISE NOTICE 'PASS: initial direct telemetry INSERT denied';
END;
$check$;

-- Simulate the legacy bootstrap permission.
GRANT INSERT ON public.telemetry_samples
  TO pulse_metrics_app;

DO $check$
BEGIN
  IF NOT has_any_column_privilege(
    'pulse_metrics_app',
    'public.telemetry_samples',
    'INSERT'
  ) THEN
    RAISE EXCEPTION
      'Legacy permission regression was not reproduced';
  END IF;

  RAISE NOTICE
    'PASS: simulated legacy grant restores unsafe INSERT privilege';
END;
$check$;

-- No simulated grant may survive.
ROLLBACK;

DO $check$
BEGIN
  IF has_any_column_privilege(
    'pulse_metrics_app',
    'public.telemetry_samples',
    'INSERT'
  ) THEN
    RAISE EXCEPTION
      'D15B direct-write protection was not restored';
  END IF;

  RAISE NOTICE
    'PASS: rollback restored protected telemetry permissions';
END;
$check$;
