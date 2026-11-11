-- Same foundational grants documented in docs/database-foundation.md.
-- Only apply after Drizzle's original base migration, on isolated cluster.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Expected isolated pulse_metrics database as postgres';
  END IF;
  IF to_regclass('public.telemetry_samples') IS NULL OR
     to_regclass('public.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'Core Drizzle migration must run first';
  END IF;
END;
$guard$;
GRANT SELECT ON public.organizations, public.users,
  public.organization_memberships, public.monitored_agents,
  public.telemetry_samples, public.audit_events TO pulse_metrics_app;
GRANT INSERT ON public.telemetry_samples, public.audit_events TO pulse_metrics_app;
GRANT USAGE, SELECT ON SEQUENCE public.telemetry_samples_id_seq TO pulse_metrics_app;
GRANT USAGE ON TYPE public.agent_status, public.audit_actor_type,
  public.membership_role TO pulse_metrics_app;
REVOKE ALL ON public.agent_credentials, public.agent_enrollment_tokens
  FROM PUBLIC, pulse_metrics_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_events,
  public.telemetry_samples FROM PUBLIC, pulse_metrics_app;
COMMIT;
