-- Pulse Metrics — restricted WorkOS identity bootstrap, v1.
-- Local development only. Review before running in any other environment.
-- Apply with: sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics \
--   -f scripts/admin/001_workos_identity_provisioning.sql
-- This privileged bootstrap is separate from ordinary Drizzle schema migrations:
-- CREATE ROLE ... BYPASSRLS requires PostgreSQL administrator authority.
-- It grants NO new table privileges or BYPASSRLS to pulse_metrics_app.

BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Run as local postgres administrator in pulse_metrics only';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_metrics_app') THEN
    RAISE EXCEPTION 'Required runtime role is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.users'::regclass AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'The users table must already have enabled and forced RLS';
  END IF;
END;
$guard$;

DO $role$
DECLARE
  existing RECORD;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
         rolbypassrls, rolinherit
  INTO existing
  FROM pg_roles WHERE rolname = 'pulse_metrics_identity_executor';

  IF NOT FOUND THEN
    CREATE ROLE pulse_metrics_identity_executor NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF existing.rolcanlogin OR existing.rolsuper OR existing.rolcreatedb
     OR existing.rolcreaterole OR existing.rolreplication
     OR NOT existing.rolbypassrls OR existing.rolinherit THEN
    RAISE EXCEPTION 'Existing identity executor role has unexpected privileges';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid = 'pulse_metrics_identity_executor'::regrole
       OR member = 'pulse_metrics_identity_executor'::regrole
  ) THEN
    RAISE EXCEPTION 'Identity executor must have no role memberships';
  END IF;
END;
$role$;

-- The identity executor has no LOGIN and no members. BYPASSRLS is required
-- because the users table uses FORCE RLS. Grant only the operations needed
-- by the single fixed function, not general write access to customer tables.
GRANT USAGE ON SCHEMA public TO pulse_metrics_identity_executor;
REVOKE ALL PRIVILEGES ON TABLE public.users FROM pulse_metrics_identity_executor;
GRANT SELECT (id, auth_provider, auth_subject)
  ON TABLE public.users TO pulse_metrics_identity_executor;
GRANT INSERT (auth_provider, auth_subject)
  ON TABLE public.users TO pulse_metrics_identity_executor;

-- No email, display-name, organization or membership writes at this stage.
-- The caller MUST have an independently verified WorkOS access token; the
-- database function cannot authenticate JWTs by itself.
CREATE OR REPLACE FUNCTION public.resolve_workos_user(p_subject text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  resolved_id uuid;
BEGIN
  IF p_subject IS NULL
     OR length(p_subject) > 255
     OR p_subject !~ '^user_[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid WorkOS user subject'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (auth_provider, auth_subject)
  VALUES ('workos', p_subject)
  ON CONFLICT (auth_provider, auth_subject) DO NOTHING
  RETURNING id INTO resolved_id;

  IF resolved_id IS NULL THEN
    SELECT id INTO resolved_id
    FROM public.users
    WHERE auth_provider = 'workos' AND auth_subject = p_subject;
  END IF;

  IF resolved_id IS NULL THEN
    RAISE EXCEPTION 'Could not resolve WorkOS identity'
      USING ERRCODE = '40001';
  END IF;

  RETURN resolved_id;
END;
$function$;

ALTER FUNCTION public.resolve_workos_user(text)
  OWNER TO pulse_metrics_identity_executor;
REVOKE ALL ON FUNCTION public.resolve_workos_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_workos_user(text)
  TO pulse_metrics_app;

COMMIT;
