-- Isolated replay cluster only; creates minimum reviewed schema privileges.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Expected isolated pulse_metrics database as postgres';
  END IF;
  IF to_regclass('public.organizations') IS NOT NULL THEN
    RAISE EXCEPTION 'Expected empty replay database';
  END IF;
END;
$guard$;
REVOKE CONNECT, TEMPORARY ON DATABASE pulse_metrics FROM PUBLIC;
GRANT CONNECT ON DATABASE pulse_metrics TO pulse_metrics_migrator, pulse_metrics_app;
GRANT CREATE ON DATABASE pulse_metrics TO pulse_metrics_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO pulse_metrics_migrator;
GRANT USAGE ON SCHEMA public TO pulse_metrics_app;
ALTER ROLE pulse_metrics_migrator IN DATABASE pulse_metrics SET search_path=public;
ALTER ROLE pulse_metrics_app IN DATABASE pulse_metrics SET search_path=public;
ALTER DEFAULT PRIVILEGES FOR ROLE pulse_metrics_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, pulse_metrics_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pulse_metrics_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, pulse_metrics_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pulse_metrics_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
