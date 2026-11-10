-- Pulse Metrics — Phase 2E3A local invitation issuance bootstrap.
-- Review before use. Run only against LOCAL pulse_metrics as postgres.
-- This package intentionally does not add email delivery or token redemption.
-- The schema change must be reconciled with Drizzle before production migration.
BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Run as local postgres in pulse_metrics only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_metrics_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_metrics_migrator')
     OR to_regprocedure('public.resolve_workos_user(text)') IS NULL
     OR to_regprocedure('public.create_workos_organization(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Missing prerequisite runtime, migrator or identity bootstrap';
  END IF;
  IF to_regclass('public.organization_invitations') IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation table already exists; refusing to overwrite';
  END IF;
  IF to_regprocedure('public.issue_organization_invitation(text,uuid,text,text,text,timestamp with time zone)') IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation function already exists; refusing to overwrite';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN (
      'public.users'::regclass,
      'public.organizations'::regclass,
      'public.organization_memberships'::regclass,
      'public.audit_events'::regclass
    ) AND NOT (relrowsecurity AND relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Existing tenant tables must have enabled and forced RLS';
  END IF;
  -- The existing telemetry/audit foundation may intentionally permit
  -- tenant-RLS-scoped audit-event INSERTs. This bootstrap does NOT grant or
  -- broaden that permission. An existing audit INSERT grant must not be
  -- confused with unrestricted organization-membership writes.
  --
  -- Fail closed for direct identity, organization and membership writes, and
  -- for destructive audit access. FORCE RLS was verified for audit_events
  -- above; tenant-scoped audit INSERT privileges require separate review.
  IF has_table_privilege('pulse_metrics_app','public.users','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organizations','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','DELETE')
     OR has_table_privilege('pulse_metrics_app','public.audit_events','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.audit_events','DELETE')
     OR has_table_privilege('pulse_metrics_app','public.audit_events','TRUNCATE') THEN
    RAISE EXCEPTION 'Unsafe direct write permissions on protected tenant tables';
  END IF;
END;
$guard$;

-- Own the new schema object as the existing dedicated migrator, not postgres.
SET LOCAL ROLE pulse_metrics_migrator;
CREATE TABLE public.organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invited_email varchar(320) NOT NULL,
  invited_role public.membership_role NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE,
  created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_invitations_role_valid CHECK (invited_role IN ('admin','member','viewer')),
  CONSTRAINT organization_invitations_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT organization_invitations_email_format CHECK (
    invited_email = lower(btrim(invited_email)) AND
    invited_email ~ '^[a-z0-9._%+-]+@[a-z0-9-]+([.][a-z0-9-]+)*[.][a-z]{2,}$'
  ),
  CONSTRAINT organization_invitations_consumption_valid CHECK (
    (consumed_at IS NULL AND consumed_by_user_id IS NULL)
    OR (consumed_at IS NOT NULL AND consumed_by_user_id IS NOT NULL)
  ),
  CONSTRAINT organization_invitations_terminal_states CHECK (
    consumed_at IS NULL OR revoked_at IS NULL
  )
);
CREATE INDEX organization_invitations_org_created_idx
  ON public.organization_invitations (organization_id, created_at DESC);
CREATE INDEX organization_invitations_email_idx
  ON public.organization_invitations (invited_email);
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations FORCE ROW LEVEL SECURITY;
-- No policies. The ordinary runtime role gets NO direct table access.
RESET ROLE;

DO $role$
DECLARE
  existing record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls, rolinherit
    INTO existing FROM pg_roles WHERE rolname='pulse_metrics_invitation_executor';
  IF NOT FOUND THEN
    CREATE ROLE pulse_metrics_invitation_executor NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF existing.rolcanlogin OR existing.rolsuper OR existing.rolcreatedb
     OR existing.rolcreaterole OR existing.rolreplication
     OR NOT existing.rolbypassrls OR existing.rolinherit THEN
    RAISE EXCEPTION 'Invitation executor has unexpected attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE
      roleid='pulse_metrics_invitation_executor'::regrole OR
      member='pulse_metrics_invitation_executor'::regrole) THEN
    RAISE EXCEPTION 'Invitation executor must have zero memberships';
  END IF;
END;
$role$;

GRANT USAGE ON SCHEMA public TO pulse_metrics_invitation_executor;
GRANT USAGE ON TYPE public.membership_role, public.audit_actor_type
  TO pulse_metrics_invitation_executor;
GRANT SELECT (id,auth_provider,auth_subject)
  ON public.users TO pulse_metrics_invitation_executor;
GRANT SELECT (organization_id,user_id,role)
  ON public.organization_memberships TO pulse_metrics_invitation_executor;
GRANT INSERT (organization_id,invited_email,invited_role,token_hash,
              created_by_user_id,expires_at), SELECT (id)
  ON public.organization_invitations TO pulse_metrics_invitation_executor;
GRANT INSERT (organization_id,actor_type,actor_user_id,event_type,
              subject_type,subject_id,metadata)
  ON public.audit_events TO pulse_metrics_invitation_executor;

-- Contract: subject from verified bearer, hash of cryptographically random
-- single-use secret generated by the API, not a password or JWT. The DB cannot
-- verify WorkOS claims or token randomness on its own.
CREATE FUNCTION public.issue_organization_invitation(
  p_subject text,
  p_organization_id uuid,
  p_email text,
  p_role text,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $function$
DECLARE
  v_actor_id uuid;
  v_actor_role public.membership_role;
  v_invitation_id uuid;
  v_email text;
BEGIN
  IF p_subject IS NULL OR length(p_subject)>255
     OR p_subject !~ '^user_[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid identity subject' USING ERRCODE='22023';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Invalid organization' USING ERRCODE='22023';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin','member','viewer') THEN
    RAISE EXCEPTION 'Invalid invitation role' USING ERRCODE='22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid token digest' USING ERRCODE='22023';
  END IF;
  IF p_expires_at IS NULL
     OR p_expires_at <= statement_timestamp()+interval '5 minutes'
     OR p_expires_at > statement_timestamp()+interval '7 days' THEN
    RAISE EXCEPTION 'Invalid invitation expiry' USING ERRCODE='22023';
  END IF;
  v_email:=lower(btrim(p_email));
  IF p_email IS NULL OR length(v_email)>320
     OR v_email !~ '^[a-z0-9._%+-]+@[a-z0-9-]+([.][a-z0-9-]+)*[.][a-z]{2,}$' THEN
    RAISE EXCEPTION 'Invalid invitee email' USING ERRCODE='22023';
  END IF;

  SELECT u.id INTO v_actor_id
  FROM public.users u
  WHERE u.auth_provider='workos' AND u.auth_subject=p_subject;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Invitation permission denied' USING ERRCODE='42501';
  END IF;

  SELECT m.role INTO v_actor_role
  FROM public.organization_memberships m
  WHERE m.organization_id=p_organization_id AND m.user_id=v_actor_id;

  -- An admin may invite only member/viewer. Only an owner may invite admins.
  IF v_actor_role <> 'owner'
     AND NOT (v_actor_role='admin' AND p_role IN ('member','viewer')) THEN
    RAISE EXCEPTION 'Invitation permission denied' USING ERRCODE='42501';
  END IF;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Invitation permission denied' USING ERRCODE='42501';
  END IF;

  INSERT INTO public.organization_invitations
    (organization_id,invited_email,invited_role,token_hash,created_by_user_id,expires_at)
  VALUES
    (p_organization_id,v_email,p_role::public.membership_role,
     p_token_hash,v_actor_id,p_expires_at)
  RETURNING id INTO v_invitation_id;

  INSERT INTO public.audit_events
    (organization_id,actor_type,actor_user_id,event_type,subject_type,subject_id,metadata)
  VALUES
    (p_organization_id,'user',v_actor_id,'organization.invitation.created',
     'organization_invitation',v_invitation_id::text,
     jsonb_build_object('role',p_role));
  RETURN v_invitation_id;
END;
$function$;
ALTER FUNCTION public.issue_organization_invitation(
  text,uuid,text,text,text,timestamptz)
  OWNER TO pulse_metrics_invitation_executor;
REVOKE ALL ON FUNCTION public.issue_organization_invitation(
  text,uuid,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_organization_invitation(
  text,uuid,text,text,text,timestamptz) TO pulse_metrics_app;

COMMIT;
