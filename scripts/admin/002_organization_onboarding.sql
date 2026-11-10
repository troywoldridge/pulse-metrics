-- Pulse Metrics — Phase 2C. Local privileged organization bootstrap.
-- Requires 001_workos_identity_provisioning.sql and existing schema/RLS.
-- Apply only to local pulse_metrics with sudo -u postgres psql -X -v ON_ERROR_STOP=1
-- This does not modify Drizzle schema, base table grants, or the migration ledger.
-- REVIEW BEFORE RUNNING. Admin bootstrap is not a general production migration.

BEGIN;

DO $guard$
DECLARE
  protected_count integer;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Local postgres administrator and pulse_metrics database required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_metrics_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_metrics_migrator')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_metrics_identity_executor')
     OR to_regprocedure('public.resolve_workos_user(text)') IS NULL THEN
    RAISE EXCEPTION 'Phase 1 and Phase 2A roles/functions are required';
  END IF;

  SELECT count(*) INTO protected_count
  FROM pg_class
  WHERE oid IN (
    'public.users'::regclass,
    'public.organizations'::regclass,
    'public.organization_memberships'::regclass,
    'public.audit_events'::regclass
  )
    AND relrowsecurity AND relforcerowsecurity
    AND relowner = 'pulse_metrics_migrator'::regrole;

  IF protected_count <> 4 THEN
    RAISE EXCEPTION 'Expected four migration-owned FORCE RLS tables';
  END IF;

  IF has_table_privilege('pulse_metrics_app', 'public.users', 'INSERT')
     OR has_table_privilege('pulse_metrics_app', 'public.organizations', 'INSERT')
     OR has_table_privilege('pulse_metrics_app', 'public.organization_memberships', 'INSERT') THEN
    RAISE EXCEPTION 'Runtime identity/org table privileges are unexpectedly broad';
  END IF;
END;
$guard$;

DO $role$
DECLARE
  existing record;
  existing_function oid;
  function_owner oid;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls, rolinherit
  INTO existing
  FROM pg_roles
  WHERE rolname = 'pulse_metrics_onboarding_executor';

  IF NOT FOUND THEN
    CREATE ROLE pulse_metrics_onboarding_executor NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF existing.rolcanlogin OR existing.rolsuper OR existing.rolcreatedb
     OR existing.rolcreaterole OR existing.rolreplication
     OR NOT existing.rolbypassrls OR existing.rolinherit THEN
    RAISE EXCEPTION 'Existing onboarding executor role is not restricted as expected';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid = 'pulse_metrics_onboarding_executor'::regrole
       OR member = 'pulse_metrics_onboarding_executor'::regrole
  ) THEN
    RAISE EXCEPTION 'Onboarding executor role must have no role memberships';
  END IF;

  SELECT to_regprocedure('public.create_workos_organization(text,text,text)')
  INTO existing_function;
  IF existing_function IS NOT NULL THEN
    SELECT proowner INTO function_owner FROM pg_proc WHERE oid = existing_function;
    IF function_owner <> 'pulse_metrics_onboarding_executor'::regrole THEN
      RAISE EXCEPTION 'Existing onboarding function has unexpected owner; refusing replacement';
    END IF;
  END IF;
END;
$role$;

-- An isolated NOLOGIN role with explicit, column-limited grants owns this one
-- immutable-body SECURITY DEFINER function. NO member roles may assume it.
-- PostgreSQL BYPASSRLS is a significant capability; audit grants continually.
GRANT USAGE ON SCHEMA public TO pulse_metrics_onboarding_executor;
GRANT USAGE ON TYPE public.membership_role, public.audit_actor_type
  TO pulse_metrics_onboarding_executor;
REVOKE ALL ON TABLE public.users, public.organizations,
  public.organization_memberships, public.audit_events
  FROM pulse_metrics_onboarding_executor;

GRANT SELECT (id, auth_provider, auth_subject)
  ON public.users TO pulse_metrics_onboarding_executor;
GRANT INSERT (name, slug), SELECT (id)
  ON public.organizations TO pulse_metrics_onboarding_executor;
GRANT INSERT (organization_id, user_id, role)
  ON public.organization_memberships TO pulse_metrics_onboarding_executor;
GRANT INSERT (organization_id, actor_type, actor_user_id,
  event_type, subject_type, subject_id, metadata)
  ON public.audit_events TO pulse_metrics_onboarding_executor;

-- p_subject must come from the verified WorkOS middleware, NEVER from a
-- browser field. This function cannot validate a JWT or session on its own.
-- There is deliberately no way for the caller to choose a role or user UUID.
-- A single SQL statement is atomic: org, membership and audit succeed or none.
CREATE OR REPLACE FUNCTION public.create_workos_organization(
  p_subject text,
  p_name text,
  p_slug text
)
RETURNS TABLE (organization_id uuid, organization_slug text, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_user_id uuid;
  v_organization_id uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) > 255
      OR p_subject !~ '^user_[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid verified WorkOS subject' USING ERRCODE = '22023';
  END IF;

  IF p_name IS NULL OR length(p_name) > 160
      OR length(btrim(p_name)) = 0
      OR p_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid organization name' USING ERRCODE = '22023';
  END IF;

  IF p_slug IS NULL OR length(p_slug) > 80
      OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'Invalid organization slug' USING ERRCODE = '22023';
  END IF;

  SELECT u.id INTO v_user_id
  FROM public.users AS u
  WHERE u.auth_provider = 'workos' AND u.auth_subject = p_subject;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Verified WorkOS user has not been provisioned'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.organizations (name, slug)
  VALUES (btrim(p_name), p_slug)
  RETURNING id INTO v_organization_id;

  INSERT INTO public.organization_memberships
    (organization_id, user_id, role)
  VALUES (v_organization_id, v_user_id, 'owner');

  INSERT INTO public.audit_events
    (organization_id, actor_type, actor_user_id, event_type,
     subject_type, subject_id, metadata)
  VALUES
    (v_organization_id, 'user', v_user_id, 'organization.created',
     'organization', v_organization_id::text, '{}'::jsonb);

  organization_id := v_organization_id;
  organization_slug := p_slug;
  membership_role := 'owner';
  RETURN NEXT;
END;
$function$;

ALTER FUNCTION public.create_workos_organization(text,text,text)
  OWNER TO pulse_metrics_onboarding_executor;
REVOKE ALL ON FUNCTION public.create_workos_organization(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_workos_organization(text,text,text)
  TO pulse_metrics_app;

COMMIT;
