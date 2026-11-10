-- Pulse Metrics — Phase 2E3C3: trusted WorkOS verified-email persistence.
-- LOCAL DEVELOPMENT ONLY. Review before applying. Never run in production.
-- Prerequisites: 001/002/003/004, migrator-owned public.users FORCE RLS.
-- This function does not verify a JWT or contact WorkOS. A trusted backend
-- must independently fetch the current WorkOS user with a SERVER-ONLY API key.
-- Its sole allowed caller is the backend with a genuinely verified subject
-- and provider-verified email (or NULL when explicitly unverified).
BEGIN;

DO $guard$
DECLARE
  r record;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Local pulse_metrics database as postgres required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_metrics_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_metrics_migrator')
     OR to_regprocedure('public.resolve_workos_user(text)') IS NULL
     OR to_regprocedure('public.accept_organization_invitation(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Missing prior identity and acceptance foundations';
  END IF;
  SELECT relrowsecurity, relforcerowsecurity, relowner
    INTO r FROM pg_class WHERE oid='public.users'::regclass;
  IF NOT FOUND OR NOT r.relrowsecurity OR NOT r.relforcerowsecurity
     OR r.relowner <> 'pulse_metrics_migrator'::regrole THEN
    RAISE EXCEPTION 'users must be migrator-owned and FORCE RLS';
  END IF;
  IF to_regprocedure('public.sync_workos_verified_email(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Email sync function already exists; refusing replacement';
  END IF;
  IF has_table_privilege('pulse_metrics_app','public.users','UPDATE')
     OR has_column_privilege('pulse_metrics_app','public.users','email','UPDATE')
     OR has_column_privilege('pulse_metrics_app','public.users','email_verified_at','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','UPDATE') THEN
    RAISE EXCEPTION 'Runtime has unsafe direct identity/membership write privileges';
  END IF;
END;
$guard$;

DO $role$
DECLARE
  r record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
         rolbypassrls, rolinherit
    INTO r FROM pg_roles WHERE rolname='pulse_metrics_email_sync_executor';
  IF NOT FOUND THEN
    CREATE ROLE pulse_metrics_email_sync_executor NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolreplication OR NOT r.rolbypassrls OR r.rolinherit THEN
    RAISE EXCEPTION 'Existing email sync executor has unsafe attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE
      roleid='pulse_metrics_email_sync_executor'::regrole OR
      member='pulse_metrics_email_sync_executor'::regrole) THEN
    RAISE EXCEPTION 'Email sync executor must have no role memberships';
  END IF;
END;
$role$;

GRANT USAGE ON SCHEMA public TO pulse_metrics_email_sync_executor;
REVOKE ALL ON TABLE public.users FROM pulse_metrics_email_sync_executor;
GRANT SELECT (id,auth_provider,auth_subject)
  ON public.users TO pulse_metrics_email_sync_executor;
GRANT UPDATE (email,email_verified_at,updated_at)
  ON public.users TO pulse_metrics_email_sync_executor;

-- No INSERT, DELETE, or rights on any membership/invitation/audit table.
-- Only existing WorkOS identities are eligible; provision separately using
-- public.resolve_workos_user() after bearer verification.
-- NULL email means WorkOS explicitly reports unverified: clear stale evidence.
-- API errors must NOT be translated into NULL; refuse the entire operation.
CREATE FUNCTION public.sync_workos_verified_email(
  p_subject text,
  p_verified_email text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_email text;
  v_user_id uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject)>255
     OR p_subject !~ '^user_[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid verified WorkOS subject' USING ERRCODE='22023';
  END IF;
  IF p_verified_email IS NOT NULL THEN
    v_email := lower(btrim(p_verified_email));
    IF length(v_email)<3 OR length(v_email)>320
       OR v_email !~ '^[a-z0-9._%+-]+@[a-z0-9-]+([.][a-z0-9-]+)*[.][a-z]{2,}$' THEN
      RAISE EXCEPTION 'Invalid verified WorkOS email' USING ERRCODE='22023';
    END IF;
  END IF;

  UPDATE public.users AS u
  SET email=v_email,
      email_verified_at=CASE WHEN v_email IS NULL THEN NULL
                             ELSE statement_timestamp() END,
      updated_at=statement_timestamp()
  WHERE u.auth_provider='workos' AND u.auth_subject=p_subject
  RETURNING u.id INTO v_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Verified WorkOS identity is not provisioned'
      USING ERRCODE='P0002';
  END IF;
  RETURN v_user_id;
END;
$function$;

ALTER FUNCTION public.sync_workos_verified_email(text,text)
  OWNER TO pulse_metrics_email_sync_executor;
REVOKE ALL ON FUNCTION public.sync_workos_verified_email(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_workos_verified_email(text,text)
  TO pulse_metrics_app;
COMMIT;
