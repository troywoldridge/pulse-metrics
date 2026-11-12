-- Phase 2E3C5D7 — ISOLATED, DISPOSABLE PostgreSQL agent enrollment rehearsal.
-- NOT a production migration and MUST NOT run against a developer database.
-- The shell harness verifies a private Unix-only disposable cluster before use.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR current_setting('data_directory') !~ '^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL
     OR to_regnamespace('pulse_agent_rehearsal') IS NOT NULL
     OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
     OR (SELECT count(*) FROM public.__drizzle_migrations) <> 1 THEN
    RAISE EXCEPTION 'REFUSE_AGENT_REHEARSAL: not isolated six-step fresh replay';
  END IF;
  IF has_table_privilege('pulse_metrics_app', 'public.agent_credentials', 'SELECT')
     OR has_table_privilege('pulse_metrics_app', 'public.agent_enrollment_tokens', 'SELECT')
     OR has_table_privilege('pulse_metrics_app', 'public.monitored_agents', 'INSERT') THEN
    RAISE EXCEPTION 'REFUSE_AGENT_REHEARSAL: unsafe runtime grants';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN
    ('public.agent_credentials'::regclass,'public.agent_enrollment_tokens'::regclass,
     'public.monitored_agents'::regclass,'public.audit_events'::regclass)
     AND NOT (relrowsecurity AND relforcerowsecurity)) THEN
    RAISE EXCEPTION 'REFUSE_AGENT_REHEARSAL: missing forced RLS';
  END IF;
END;
$guard$;

CREATE SCHEMA pulse_agent_rehearsal AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA pulse_agent_rehearsal FROM PUBLIC;

CREATE ROLE pulse_agent_rehearsal_executor NOLOGIN NOINHERIT BYPASSRLS;
GRANT USAGE ON SCHEMA public TO pulse_agent_rehearsal_executor;
GRANT USAGE ON TYPE public.agent_status, public.audit_actor_type, public.membership_role
  TO pulse_agent_rehearsal_executor;
GRANT USAGE ON SCHEMA pulse_agent_rehearsal TO pulse_metrics_app, pulse_agent_rehearsal_executor;

GRANT SELECT (id, auth_provider, auth_subject) ON public.users TO pulse_agent_rehearsal_executor;
GRANT SELECT (organization_id, user_id, role) ON public.organization_memberships
  TO pulse_agent_rehearsal_executor;
GRANT SELECT (id, organization_id, token_hash, max_uses, uses, expires_at,
              consumed_at, revoked_at)
  ON public.agent_enrollment_tokens TO pulse_agent_rehearsal_executor;
GRANT INSERT (organization_id, token_prefix, token_hash, label, created_by_user_id,
              max_uses, uses, expires_at),
      UPDATE (uses, consumed_at)
  ON public.agent_enrollment_tokens TO pulse_agent_rehearsal_executor;
GRANT SELECT (id, organization_id, status) ON public.monitored_agents TO pulse_agent_rehearsal_executor;
GRANT INSERT (organization_id, display_name, hostname, platform, architecture, status, enrolled_at),
      UPDATE (status, updated_at)
  ON public.monitored_agents TO pulse_agent_rehearsal_executor;
GRANT SELECT (id, organization_id, agent_id, token_hash, revoked_at, expires_at)
  ON public.agent_credentials TO pulse_agent_rehearsal_executor;
GRANT INSERT (organization_id, agent_id, token_prefix, token_hash, scopes, expires_at),
      UPDATE (revoked_at, last_used_at)
  ON public.agent_credentials TO pulse_agent_rehearsal_executor;
GRANT INSERT (organization_id, actor_type, actor_user_id, actor_agent_id,
              event_type, subject_type, subject_id, metadata)
  ON public.audit_events TO pulse_agent_rehearsal_executor;

CREATE FUNCTION pulse_agent_rehearsal.issue_enrollment(
  p_subject text, p_org uuid, p_hash text, p_prefix text,
  p_label text, p_expires timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE v_user uuid; v_role public.membership_role; v_id uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject)>255 OR p_subject !~ '^user_[A-Za-z0-9_-]+$'
     OR p_org IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
     OR p_prefix IS NULL OR p_prefix <> left(p_hash,12)
     OR p_label IS NULL OR length(btrim(p_label))<1 OR length(p_label)>120
     OR p_label ~ '[[:cntrl:]]'
     OR p_expires IS NULL OR p_expires <= statement_timestamp()+interval '2 minutes'
     OR p_expires > statement_timestamp()+interval '15 minutes' THEN
    RAISE EXCEPTION 'Invalid enrollment request' USING ERRCODE='22023';
  END IF;
  SELECT u.id INTO v_user FROM public.users u
    WHERE u.auth_provider='workos' AND u.auth_subject=p_subject;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END IF;
  SELECT m.role INTO v_role FROM public.organization_memberships m
    WHERE m.user_id=v_user AND m.organization_id=p_org;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.agent_enrollment_tokens
    (organization_id,token_prefix,token_hash,label,created_by_user_id,max_uses,uses,expires_at)
  VALUES (p_org,p_prefix,p_hash,btrim(p_label),v_user,1,0,p_expires)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_events
    (organization_id,actor_type,actor_user_id,event_type,subject_type,subject_id,metadata)
  VALUES (p_org,'user',v_user,'agent.enrollment_issued','agent_enrollment',v_id::text,'{}'::jsonb);
  RETURN v_id;
END;
$fn$;
ALTER FUNCTION pulse_agent_rehearsal.issue_enrollment(text,uuid,text,text,text,timestamptz)
  OWNER TO pulse_agent_rehearsal_executor;
REVOKE ALL ON FUNCTION pulse_agent_rehearsal.issue_enrollment(text,uuid,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_agent_rehearsal.issue_enrollment(text,uuid,text,text,text,timestamptz)
  TO pulse_metrics_app;

CREATE FUNCTION pulse_agent_rehearsal.redeem_enrollment(
  p_hash text, p_credential_hash text, p_credential_prefix text,
  p_name text, p_hostname text, p_platform text, p_arch text
) RETURNS TABLE (organization_id uuid, agent_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE v_enroll record; v_agent uuid;
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
     OR p_arch IS NULL THEN
    RAISE EXCEPTION 'Invalid agent enrollment payload' USING ERRCODE='22023';
  END IF;
  -- A row lock serializes concurrent redeemers, including across API workers.
  SELECT t.id,t.organization_id,t.uses,t.max_uses,t.expires_at,t.revoked_at,t.consumed_at
    INTO v_enroll FROM public.agent_enrollment_tokens t
    WHERE t.token_hash=p_hash FOR UPDATE;
  IF NOT FOUND OR v_enroll.uses <> 0 OR v_enroll.max_uses <> 1
     OR v_enroll.consumed_at IS NOT NULL OR v_enroll.revoked_at IS NOT NULL
     OR v_enroll.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Enrollment unavailable' USING ERRCODE='P0002';
  END IF;
  INSERT INTO public.monitored_agents
    (organization_id,display_name,hostname,platform,architecture,status,enrolled_at)
  VALUES (v_enroll.organization_id,btrim(p_name),p_hostname,'linux',p_arch,'active',clock_timestamp())
  RETURNING id INTO v_agent;
  INSERT INTO public.agent_credentials
    (organization_id,agent_id,token_prefix,token_hash,scopes,expires_at)
  VALUES (v_enroll.organization_id,v_agent,p_credential_prefix,p_credential_hash,
          '["telemetry:write"]'::jsonb,clock_timestamp()+interval '30 days');
  UPDATE public.agent_enrollment_tokens SET uses=1,consumed_at=clock_timestamp()
    WHERE id=v_enroll.id;
  INSERT INTO public.audit_events
    (organization_id,actor_type,actor_agent_id,event_type,subject_type,subject_id,metadata)
  VALUES (v_enroll.organization_id,'agent',v_agent,'agent.enrolled','agent',v_agent::text,'{}'::jsonb);
  organization_id := v_enroll.organization_id;
  agent_id := v_agent;
  RETURN NEXT;
END;
$fn$;
ALTER FUNCTION pulse_agent_rehearsal.redeem_enrollment(text,text,text,text,text,text,text)
  OWNER TO pulse_agent_rehearsal_executor;
REVOKE ALL ON FUNCTION pulse_agent_rehearsal.redeem_enrollment(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_agent_rehearsal.redeem_enrollment(text,text,text,text,text,text,text)
  TO pulse_metrics_app;

CREATE FUNCTION pulse_agent_rehearsal.verify_credential(p_hash text)
RETURNS TABLE (organization_id uuid, agent_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE v_creds record;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid credential format' USING ERRCODE='22023';
  END IF;
  -- Strict hash match and agent revocation state are required. No client-org hint.
  SELECT c.id,c.organization_id,c.agent_id INTO v_creds
    FROM public.agent_credentials c
    JOIN public.monitored_agents a ON a.id=c.agent_id AND a.organization_id=c.organization_id
    WHERE c.token_hash=p_hash AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())
      AND a.status <> 'revoked'
    FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.agent_credentials c SET last_used_at=clock_timestamp()
    WHERE c.id=v_creds.id;
  organization_id:=v_creds.organization_id;
  agent_id:=v_creds.agent_id;
  RETURN NEXT;
END;
$fn$;
ALTER FUNCTION pulse_agent_rehearsal.verify_credential(text)
  OWNER TO pulse_agent_rehearsal_executor;
REVOKE ALL ON FUNCTION pulse_agent_rehearsal.verify_credential(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_agent_rehearsal.verify_credential(text) TO pulse_metrics_app;

CREATE FUNCTION pulse_agent_rehearsal.revoke_agent(p_subject text, p_org uuid, p_agent uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE v_user uuid; v_role public.membership_role; v_status public.agent_status;
BEGIN
  IF p_subject IS NULL OR length(p_subject)>255 OR p_subject !~ '^user_[A-Za-z0-9_-]+$'
     OR p_org IS NULL OR p_agent IS NULL THEN
    RAISE EXCEPTION 'Invalid revoke request' USING ERRCODE='22023';
  END IF;
  SELECT u.id INTO v_user FROM public.users u
    WHERE u.auth_provider='workos' AND u.auth_subject=p_subject;
  SELECT m.role INTO v_role FROM public.organization_memberships m
    WHERE m.user_id=v_user AND m.organization_id=p_org;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END IF;
  SELECT a.status INTO v_status FROM public.monitored_agents a
    WHERE a.id=p_agent AND a.organization_id=p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent unavailable' USING ERRCODE='P0002'; END IF;
  IF v_status='revoked' THEN RETURN false; END IF;
  UPDATE public.agent_credentials c SET revoked_at=clock_timestamp()
    WHERE c.organization_id=p_org AND c.agent_id=p_agent AND c.revoked_at IS NULL;
  UPDATE public.monitored_agents a SET status='revoked',updated_at=clock_timestamp()
    WHERE a.organization_id=p_org AND a.id=p_agent;
  INSERT INTO public.audit_events
    (organization_id,actor_type,actor_user_id,event_type,subject_type,subject_id,metadata)
  VALUES (p_org,'user',v_user,'agent.revoked','agent',p_agent::text,'{}'::jsonb);
  RETURN true;
END;
$fn$;
ALTER FUNCTION pulse_agent_rehearsal.revoke_agent(text,uuid,uuid)
  OWNER TO pulse_agent_rehearsal_executor;
REVOKE ALL ON FUNCTION pulse_agent_rehearsal.revoke_agent(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_agent_rehearsal.revoke_agent(text,uuid,uuid) TO pulse_metrics_app;

CREATE FUNCTION pulse_agent_rehearsal.rotate_credential(
  p_subject text, p_org uuid, p_agent uuid, p_hash text, p_prefix text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE v_user uuid; v_role public.membership_role; v_status public.agent_status;
BEGIN
  IF p_subject IS NULL OR length(p_subject)>255 OR p_subject !~ '^user_[A-Za-z0-9_-]+$'
     OR p_org IS NULL OR p_agent IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
     OR p_prefix IS NULL OR p_prefix <> left(p_hash,12) THEN
    RAISE EXCEPTION 'Invalid credential rotation request' USING ERRCODE='22023';
  END IF;
  SELECT u.id INTO v_user FROM public.users u
    WHERE u.auth_provider='workos' AND u.auth_subject=p_subject;
  SELECT m.role INTO v_role FROM public.organization_memberships m
    WHERE m.user_id=v_user AND m.organization_id=p_org;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END IF;
  SELECT a.status INTO v_status FROM public.monitored_agents a
    WHERE a.organization_id=p_org AND a.id=p_agent FOR UPDATE;
  IF NOT FOUND OR v_status='revoked' THEN
    RAISE EXCEPTION 'Agent unavailable' USING ERRCODE='P0002';
  END IF;
  -- The agent row lock serializes rotations with revocation/other rotations.
  UPDATE public.agent_credentials c SET revoked_at=clock_timestamp()
    WHERE c.organization_id=p_org AND c.agent_id=p_agent AND c.revoked_at IS NULL;
  INSERT INTO public.agent_credentials
    (organization_id,agent_id,token_prefix,token_hash,scopes,expires_at)
  VALUES (p_org,p_agent,p_prefix,p_hash,'["telemetry:write"]'::jsonb,
          clock_timestamp()+interval '30 days');
  INSERT INTO public.audit_events
    (organization_id,actor_type,actor_user_id,event_type,subject_type,subject_id,metadata)
  VALUES (p_org,'user',v_user,'agent.credential_rotated','agent',p_agent::text,'{}'::jsonb);
  RETURN true;
END;
$fn$;
ALTER FUNCTION pulse_agent_rehearsal.rotate_credential(text,uuid,uuid,text,text)
  OWNER TO pulse_agent_rehearsal_executor;
REVOKE ALL ON FUNCTION pulse_agent_rehearsal.rotate_credential(text,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_agent_rehearsal.rotate_credential(text,uuid,uuid,text,text)
  TO pulse_metrics_app;
COMMIT;
