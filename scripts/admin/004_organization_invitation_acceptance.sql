-- Pulse Metrics — Phase 2E3C1: single-use acceptance foundation (LOCAL DEV).
-- Installs a fixed-function PostgreSQL trust boundary; no HTTP route or email
-- synchronization is added. Review before applying. Never run on production.
-- Requires 001 identity, 002 organization and 003 invitation bootstraps.
-- Apply with: sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pulse_metrics -f scripts/admin/004_organization_invitation_acceptance.sql

BEGIN;

DO $guard$
DECLARE
  protected_count integer;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Local pulse_metrics database as postgres administrator required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_migrator')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_invitation_executor')
     OR to_regprocedure('public.issue_organization_invitation(text,uuid,text,text,text,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.resolve_workos_user(text)') IS NULL THEN
    RAISE EXCEPTION 'Prerequisite restricted roles or invitation function missing';
  END IF;
  IF to_regprocedure('public.accept_organization_invitation(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Acceptance function already exists; refusing replacement';
  END IF;
  SELECT count(*) INTO protected_count
  FROM pg_class
  WHERE oid IN (
    'public.users'::regclass,
    'public.organizations'::regclass,
    'public.organization_memberships'::regclass,
    'public.organization_invitations'::regclass,
    'public.audit_events'::regclass
  ) AND relrowsecurity AND relforcerowsecurity
    AND relowner = 'pulse_metrics_migrator'::regrole;
  IF protected_count <> 5 THEN
    RAISE EXCEPTION 'Expected five migrator-owned FORCE RLS tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='organization_invitations'
  ) THEN
    RAISE EXCEPTION 'Invitation table must have no direct RLS policies';
  END IF;
  IF has_table_privilege('pulse_metrics_app','public.users','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','DELETE')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','SELECT')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','INSERT') THEN
    RAISE EXCEPTION 'Runtime has unsafe direct table privileges';
  END IF;
END;
$guard$;

DO $role$
DECLARE
  r record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
         rolbypassrls, rolinherit
    INTO r FROM pg_roles WHERE rolname='pulse_metrics_acceptance_executor';
  IF NOT FOUND THEN
    CREATE ROLE pulse_metrics_acceptance_executor NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolreplication OR NOT r.rolbypassrls OR r.rolinherit THEN
    RAISE EXCEPTION 'Existing acceptance executor has unsafe attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE
       roleid='pulse_metrics_acceptance_executor'::regrole
       OR member='pulse_metrics_acceptance_executor'::regrole) THEN
    RAISE EXCEPTION 'Acceptance executor must have no role memberships';
  END IF;
END;
$role$;

-- No LOGIN or memberships. Allow only columns used by this fixed function.
-- BYPASSRLS belongs to this narrow function owner, NEVER to pulse_metrics_app.
GRANT USAGE ON SCHEMA public TO pulse_metrics_acceptance_executor;
GRANT USAGE ON TYPE public.membership_role, public.audit_actor_type
  TO pulse_metrics_acceptance_executor;
REVOKE ALL ON TABLE public.users, public.organization_memberships,
  public.organization_invitations, public.audit_events
  FROM pulse_metrics_acceptance_executor;
GRANT SELECT (id,auth_provider,auth_subject,email,email_verified_at)
  ON public.users TO pulse_metrics_acceptance_executor;
GRANT SELECT (id,organization_id,invited_email,invited_role,token_hash,
              expires_at,consumed_at,revoked_at)
  ON public.organization_invitations TO pulse_metrics_acceptance_executor;
GRANT UPDATE (consumed_at,consumed_by_user_id)
  ON public.organization_invitations TO pulse_metrics_acceptance_executor;
GRANT INSERT (organization_id,user_id,role)
  ON public.organization_memberships TO pulse_metrics_acceptance_executor;
GRANT INSERT (organization_id,actor_type,actor_user_id,event_type,
              subject_type,subject_id,metadata)
  ON public.audit_events TO pulse_metrics_acceptance_executor;

-- TRUST BOUNDARY:
-- p_subject is NOT checked by PostgreSQL against WorkOS; it MUST come only
-- from a freshly verified bearer token in a future authenticated adapter.
-- p_token_hash MUST be SHA-256 of a user-supplied one-time secret computed
-- in that server adapter, not accepted from browser as a hash directly.
-- Recipient email is *never* an argument. It is read from users.email
-- where email_verified_at is present, populated exclusively by a future
-- trusted WorkOS email verification adapter (not implemented here).
-- The UPDATE+membership+audit are one atomic statement-level transaction.
CREATE FUNCTION public.accept_organization_invitation(
  p_subject text, p_token_hash text
)
RETURNS TABLE(organization_id uuid, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_user_id uuid;
  v_verified_email text;
  v_invitation_id uuid;
  v_organization_id uuid;
  v_role public.membership_role;
BEGIN
  IF p_subject IS NULL OR length(p_subject)>255
     OR p_subject !~ '^user_[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid verified identity' USING ERRCODE='22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid invitation secret digest' USING ERRCODE='22023';
  END IF;

  SELECT u.id, lower(btrim(u.email))
    INTO v_user_id, v_verified_email
  FROM public.users u
  WHERE u.auth_provider='workos'
    AND u.auth_subject=p_subject
    AND u.email IS NOT NULL
    AND u.email_verified_at IS NOT NULL
    AND u.email_verified_at <= statement_timestamp();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='P0002';
  END IF;

  -- Concurrent uses of the same hash serialize on UPDATE row locking;
  -- the second caller rechecks consumed_at and cannot consume it again.
  UPDATE public.organization_invitations AS i
  SET consumed_at=statement_timestamp(), consumed_by_user_id=v_user_id
  WHERE i.token_hash=p_token_hash
    AND i.invited_email=v_verified_email
    AND i.expires_at>statement_timestamp()
    AND i.consumed_at IS NULL
    AND i.revoked_at IS NULL
    AND i.invited_role IN ('admin','member','viewer')
  RETURNING i.id, i.organization_id, i.invited_role
    INTO v_invitation_id, v_organization_id, v_role;

  IF v_invitation_id IS NULL THEN
    RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='P0002';
  END IF;

  -- Deliberately no ON CONFLICT. Existing membership is NOT overwritten or
  -- promoted; a PK collision rolls back token consumption automatically.
  INSERT INTO public.organization_memberships
    (organization_id,user_id,role)
  VALUES (v_organization_id,v_user_id,v_role);

  INSERT INTO public.audit_events
    (organization_id,actor_type,actor_user_id,event_type,subject_type,subject_id,metadata)
  VALUES (v_organization_id,'user',v_user_id,'organization.invitation.accepted',
          'organization_invitation',v_invitation_id::text,
          jsonb_build_object('role',v_role::text));

  organization_id:=v_organization_id;
  membership_role:=v_role::text;
  RETURN NEXT;
END;
$function$;

ALTER FUNCTION public.accept_organization_invitation(text,text)
  OWNER TO pulse_metrics_acceptance_executor;
REVOKE ALL ON FUNCTION public.accept_organization_invitation(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_organization_invitation(text,text)
  TO pulse_metrics_app;

COMMIT;
