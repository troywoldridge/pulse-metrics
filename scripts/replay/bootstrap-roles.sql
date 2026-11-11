-- Phase 2E3C5B: ONLY against a newly created, isolated replay cluster.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Expected isolated cluster postgres maintenance database';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('pulse_metrics_migrator','pulse_metrics_app')) THEN
    RAISE EXCEPTION 'Replay roles already present: refusing reuse';
  END IF;
END;
$guard$;
CREATE ROLE pulse_metrics_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE pulse_metrics_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
COMMIT;
