-- Pulse Metrics Phase 2E3C5D13: pre-authorized, one-time agent identity.
-- REVIEW-ONLY candidate. Apply ONLY to an independent, marker-verified,
-- disposable cluster by scripts/test-agent-identity-rehearsal.sh.
-- D9 (0001), D10 (0002), and the six historic privileged steps are immutable.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
 IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
    OR to_regclass('pulse_agent_enrollment.schema_migrations') IS NULL
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 2
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations WHERE version IN ('0001','0002')) <> 2
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
    OR (SELECT count(*) FROM public.__drizzle_migrations) <> 1
    OR to_regclass('pulse_agent_enrollment.preallocated_agent_bindings') IS NOT NULL
    OR to_regprocedure('pulse_agent_enrollment.issue_preallocated_enrollment(text,uuid,text,text,text,timestamptz,text,text,text,text)') IS NOT NULL
    OR to_regprocedure('pulse_agent_enrollment.redeem_preallocated_enrollment(text,text,text,text,text,text,text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_agent_identity_executor')
 THEN
   RAISE EXCEPTION 'REFUSE_D13: exact fresh D9+D10 baseline is required';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='pulse_agent_enrollment.schema_migrations'::regclass
      AND relrowsecurity AND relforcerowsecurity AND relowner='postgres'::regrole)
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.monitored_agents'::regclass
      AND relrowsecurity AND relforcerowsecurity AND relowner='pulse_metrics_migrator'::regrole)
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.agent_enrollment_tokens'::regclass
      AND relrowsecurity AND relforcerowsecurity AND relowner='pulse_metrics_migrator'::regrole)
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.agent_credentials'::regclass
      AND relrowsecurity AND relforcerowsecurity AND relowner='pulse_metrics_migrator'::regrole)
    OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
    OR has_table_privilege('pulse_metrics_app','public.agent_enrollment_tokens','SELECT')
    OR has_table_privilege('pulse_metrics_app','public.monitored_agents','INSERT')
 THEN
   RAISE EXCEPTION 'REFUSE_D13: immutable RLS, ownership or runtime grant boundary changed';
 END IF;
END;
$guard$;

-- Constrain tenant binding twice: to the token AND to the agent. No writes
-- or reads on this forced-RLS table are granted to the ordinary app role.
ALTER TABLE public.agent_enrollment_tokens
  ADD CONSTRAINT agent_enrollment_tokens_org_id_d13 UNIQUE (organization_id,id);
CREATE TABLE pulse_agent_enrollment.preallocated_agent_bindings (
  enrollment_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT d13_bound_token_tenant FOREIGN KEY (organization_id,enrollment_id)
    REFERENCES public.agent_enrollment_tokens (organization_id,id) ON DELETE CASCADE,
  CONSTRAINT d13_bound_agent_tenant FOREIGN KEY (organization_id,agent_id)
    REFERENCES public.monitored_agents (organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE pulse_agent_enrollment.preallocated_agent_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_agent_enrollment.preallocated_agent_bindings FORCE ROW LEVEL SECURITY;

-- Column-scoped, NOLOGIN, non-inheritable executor. BYPASSRLS is needed only
-- because the protected credential and token tables have NO permissive RLS
-- policies. Role has no login, membership, broad grants or DDL privileges.
CREATE ROLE pulse_metrics_agent_identity_executor
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
GRANT USAGE ON SCHEMA public, pulse_agent_enrollment TO pulse_metrics_agent_identity_executor;
GRANT USAGE ON TYPE public.agent_status, public.membership_role, public.audit_actor_type
  TO pulse_metrics_agent_identity_executor;
GRANT SELECT (id, auth_provider, auth_subject) ON public.users TO pulse_metrics_agent_identity_executor;
GRANT SELECT (organization_id,user_id,role) ON public.organization_memberships
  TO pulse_metrics_agent_identity_executor;
GRANT SELECT (id, organization_id, status, display_name, hostname, platform, architecture)
  ON public.monitored_agents TO pulse_metrics_agent_identity_executor;
GRANT INSERT (organization_id,display_name,hostname,platform,architecture,status)
  ON public.monitored_agents TO pulse_metrics_agent_identity_executor;
GRANT UPDATE (status,enrolled_at,updated_at) ON public.monitored_agents
  TO pulse_metrics_agent_identity_executor;
GRANT SELECT (id,organization_id,token_hash,max_uses,uses,expires_at,consumed_at,revoked_at)
  ON public.agent_enrollment_tokens TO pulse_metrics_agent_identity_executor;
GRANT INSERT (organization_id,token_prefix,token_hash,label,created_by_user_id,max_uses,uses,expires_at),
      UPDATE (uses,consumed_at)
  ON public.agent_enrollment_tokens TO pulse_metrics_agent_identity_executor;
GRANT INSERT (organization_id,agent_id,token_prefix,token_hash,scopes,expires_at)
  ON public.agent_credentials TO pulse_metrics_agent_identity_executor;
GRANT INSERT (organization_id,actor_type,actor_user_id,actor_agent_id,
              event_type,subject_type,subject_id,metadata)
  ON public.audit_events TO pulse_metrics_agent_identity_executor;
GRANT SELECT (enrollment_id,organization_id,agent_id),
      INSERT (enrollment_id,organization_id,agent_id)
  ON pulse_agent_enrollment.preallocated_agent_bindings
  TO pulse_metrics_agent_identity_executor;

-- Authenticated owner/admin issues a token AND creates the pending agent
-- under one transaction. No agent ID is accepted from the request body.
CREATE FUNCTION pulse_agent_enrollment.issue_preallocated_enrollment(
  p_subject text, p_org uuid, p_hash text, p_prefix text, p_label text,
  p_expires timestamptz, p_name text, p_hostname text, p_platform text, p_arch text
) RETURNS TABLE (enrollment_id uuid, agent_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE v_user uuid; v_role public.membership_role; v_token uuid; v_agent uuid;
BEGIN
 IF p_subject IS NULL OR length(p_subject)>255 OR p_subject !~ '^user_[A-Za-z0-9_-]+$'
    OR p_org IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
    OR p_prefix IS NULL OR p_prefix <> left(p_hash,12)
    OR p_label IS NULL OR length(btrim(p_label))<1 OR length(p_label)>120
    OR p_label ~ '[[:cntrl:]]'
    OR p_expires IS NULL OR p_expires <= statement_timestamp()+interval '2 minutes'
    OR p_expires > statement_timestamp()+interval '15 minutes'
    OR p_name IS NULL OR length(btrim(p_name))<1 OR length(p_name)>120
    OR p_name ~ '[[:cntrl:]]'
    OR p_hostname IS NULL OR length(p_hostname)>255
    OR p_hostname !~ '^[A-Za-z0-9][A-Za-z0-9.-]*$'
    OR p_platform IS DISTINCT FROM 'linux' OR p_arch NOT IN ('x86_64','aarch64')
    OR p_arch IS NULL
 THEN RAISE EXCEPTION 'Invalid preauthorization' USING ERRCODE='22023'; END IF;
 SELECT u.id INTO v_user FROM public.users u
  WHERE u.auth_provider='workos' AND u.auth_subject=p_subject;
 IF v_user IS NULL THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
 SELECT m.role INTO v_role FROM public.organization_memberships m
   WHERE m.organization_id=p_org AND m.user_id=v_user;
 IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
   RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.monitored_agents
   (organization_id,display_name,hostname,platform,architecture,status)
 VALUES (p_org,btrim(p_name),p_hostname,'linux',p_arch,'pending')
 RETURNING id INTO v_agent;
 INSERT INTO public.agent_enrollment_tokens
   (organization_id,token_prefix,token_hash,label,created_by_user_id,max_uses,uses,expires_at)
 VALUES (p_org,p_prefix,p_hash,btrim(p_label),v_user,1,0,p_expires)
 RETURNING id INTO v_token;
 INSERT INTO pulse_agent_enrollment.preallocated_agent_bindings
   (enrollment_id,organization_id,agent_id) VALUES (v_token,p_org,v_agent);
 INSERT INTO public.audit_events
   (organization_id,actor_type,actor_user_id,event_type,subject_type,subject_id,metadata)
 VALUES (p_org,'user',v_user,'agent.enrollment_preauthorized','agent',v_agent::text,'{}'::jsonb);
 enrollment_id:=v_token;
 agent_id:=v_agent;
 RETURN NEXT;
END;
$fn$;
ALTER FUNCTION pulse_agent_enrollment.issue_preallocated_enrollment(text,uuid,text,text,text,timestamptz,text,text,text,text)
  OWNER TO pulse_metrics_agent_identity_executor;
REVOKE ALL ON FUNCTION pulse_agent_enrollment.issue_preallocated_enrollment(text,uuid,text,text,text,timestamptz,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_agent_enrollment.issue_preallocated_enrollment(text,uuid,text,text,text,timestamptz,text,text,text,text)
  TO pulse_metrics_app;

-- The token is the sole lookup key. It determines the tenant and EXACT
-- pending agent. A row lock ensures only one redemption wins across workers.
CREATE FUNCTION pulse_agent_enrollment.redeem_preallocated_enrollment(
  p_hash text, p_credential_hash text, p_credential_prefix text,
  p_name text, p_hostname text, p_platform text, p_arch text
) RETURNS TABLE (organization_id uuid, agent_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE v record;
BEGIN
 IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
    OR p_credential_hash IS NULL OR p_credential_hash !~ '^[0-9a-f]{64}$'
    OR p_hash=p_credential_hash OR p_credential_prefix IS NULL
    OR p_credential_prefix <> left(p_credential_hash,12)
    OR p_name IS NULL OR length(btrim(p_name))<1 OR length(p_name)>120
    OR p_name ~ '[[:cntrl:]]'
    OR p_hostname IS NULL OR length(p_hostname)>255
    OR p_hostname !~ '^[A-Za-z0-9][A-Za-z0-9.-]*$'
    OR p_platform IS DISTINCT FROM 'linux' OR p_arch NOT IN ('x86_64','aarch64')
    OR p_arch IS NULL
 THEN RAISE EXCEPTION 'Invalid redemption' USING ERRCODE='22023'; END IF;
 SELECT t.id AS token_id,t.organization_id AS org,t.uses,t.max_uses,
        t.expires_at,t.revoked_at,t.consumed_at,
        b.agent_id AS bound_agent,a.status,a.display_name,a.hostname,a.platform,a.architecture
 INTO v FROM public.agent_enrollment_tokens t
 JOIN pulse_agent_enrollment.preallocated_agent_bindings b
   ON b.enrollment_id=t.id AND b.organization_id=t.organization_id
 JOIN public.monitored_agents a
   ON a.id=b.agent_id AND a.organization_id=b.organization_id
 WHERE t.token_hash=p_hash FOR UPDATE OF t,a;
 IF NOT FOUND OR v.uses<>0 OR v.max_uses<>1
    OR v.consumed_at IS NOT NULL OR v.revoked_at IS NOT NULL
    OR v.expires_at<=clock_timestamp() OR v.status<>'pending'
    OR v.display_name<>btrim(p_name) OR v.hostname<>p_hostname
    OR v.platform<>p_platform OR v.architecture<>p_arch THEN
   RAISE EXCEPTION 'Enrollment unavailable' USING ERRCODE='P0002';
 END IF;
 -- Fully qualify target columns: RETURNS TABLE exposes organization_id as an
 -- implicit PL/pgSQL variable, so an unqualified WHERE is ambiguous (42702).
 UPDATE public.monitored_agents AS target SET status='active',enrolled_at=clock_timestamp(),
   updated_at=clock_timestamp() WHERE target.id=v.bound_agent
   AND target.organization_id=v.org AND target.status='pending';
 IF NOT FOUND THEN RAISE EXCEPTION 'Enrollment unavailable' USING ERRCODE='P0002'; END IF;
 INSERT INTO public.agent_credentials
   (organization_id,agent_id,token_prefix,token_hash,scopes,expires_at)
 VALUES (v.org,v.bound_agent,p_credential_prefix,p_credential_hash,
         '["telemetry:write"]'::jsonb,clock_timestamp()+interval '30 days');
 UPDATE public.agent_enrollment_tokens SET uses=1,consumed_at=clock_timestamp()
   WHERE id=v.token_id;
 INSERT INTO public.audit_events
   (organization_id,actor_type,actor_agent_id,event_type,subject_type,subject_id,metadata)
 VALUES (v.org,'agent',v.bound_agent,'agent.enrolled_preauthorized','agent',v.bound_agent::text,'{}'::jsonb);
 organization_id:=v.org;
 agent_id:=v.bound_agent;
 RETURN NEXT;
END;
$fn$;
ALTER FUNCTION pulse_agent_enrollment.redeem_preallocated_enrollment(text,text,text,text,text,text,text)
  OWNER TO pulse_metrics_agent_identity_executor;
REVOKE ALL ON FUNCTION pulse_agent_enrollment.redeem_preallocated_enrollment(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_agent_enrollment.redeem_preallocated_enrollment(text,text,text,text,text,text,text)
  TO pulse_metrics_app;

-- Retire the older unbound issuance/redemption API at the DATABASE boundary.
-- The old immutable SQL remains in history; the ordinary application role can
-- no longer use it after this candidate is approved and applied.
REVOKE EXECUTE ON FUNCTION pulse_agent_enrollment.issue_enrollment(text,uuid,text,text,text,timestamptz)
  FROM pulse_metrics_app;
REVOKE EXECUTE ON FUNCTION pulse_agent_enrollment.redeem_enrollment(text,text,text,text,text,text,text)
  FROM pulse_metrics_app;

-- Version receipt is atomic with all D13 SQL changes. No auto-deployment.
INSERT INTO pulse_agent_enrollment.schema_migrations(version,description)
VALUES ('0003','Pre-authorized, tenant-bound pending agent identity and redemption');
COMMIT;
