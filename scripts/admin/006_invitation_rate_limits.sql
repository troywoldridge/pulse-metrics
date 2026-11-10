-- Pulse Metrics — Phase 2E3C4B2: invitation rate-limit foundation.
-- LOCAL DEVELOPMENT ONLY; review and run as postgres in pulse_metrics.
-- This is not a production Drizzle migration. Endpoint wiring stays DISABLED.
-- The database accepts *only HMAC digests* of actor/network identifiers,
-- never IPs, raw tokens, emails or WorkOS subjects.
BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Run as postgres in local pulse_metrics only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_migrator')
     OR to_regprocedure('public.issue_organization_invitation(text,uuid,text,text,text,timestamptz)') IS NULL
     OR to_regprocedure('public.accept_organization_invitation(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Missing Phase 2E invitation prerequisites';
  END IF;
  IF to_regclass('public.invitation_rate_limits') IS NOT NULL
     OR to_regprocedure('public.consume_invitation_rate_limit(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Rate-limit objects already installed; refusing replacement';
  END IF;
  IF has_table_privilege('pulse_metrics_app','public.organization_invitations','SELECT')
     OR has_table_privilege('pulse_metrics_app','public.organization_invitations','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','INSERT') THEN
    RAISE EXCEPTION 'Unsafe preexisting runtime privileges';
  END IF;
END;
$guard$;

SET LOCAL ROLE pulse_metrics_migrator;
CREATE TABLE public.invitation_rate_limits (
  action varchar(12) NOT NULL,
  bucket_kind varchar(12) NOT NULL,
  bucket_digest varchar(64) NOT NULL,
  attempts bigint NOT NULL,
  window_end timestamptz NOT NULL,
  CONSTRAINT invitation_rate_limits_pk PRIMARY KEY (action,bucket_kind,bucket_digest),
  CONSTRAINT invitation_rate_limits_action CHECK (action IN ('issue','accept')),
  CONSTRAINT invitation_rate_limits_kind CHECK (bucket_kind IN ('actor','network')),
  CONSTRAINT invitation_rate_limits_digest CHECK (bucket_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitation_rate_limits_attempts CHECK (attempts >= 1)
);
CREATE INDEX invitation_rate_limits_window_end_idx
  ON public.invitation_rate_limits (window_end);
ALTER TABLE public.invitation_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation_rate_limits FORCE ROW LEVEL SECURITY;
-- NO RLS policies; ordinary users and runtime get no direct table access.
RESET ROLE;

DO $role$
DECLARE r record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
         rolbypassrls, rolinherit INTO r
  FROM pg_roles WHERE rolname='pulse_metrics_rate_limit_executor';
  IF NOT FOUND THEN
    CREATE ROLE pulse_metrics_rate_limit_executor NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolreplication OR NOT r.rolbypassrls OR r.rolinherit THEN
    RAISE EXCEPTION 'Rate-limit executor has unexpected role attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE
     roleid='pulse_metrics_rate_limit_executor'::regrole OR
     member='pulse_metrics_rate_limit_executor'::regrole) THEN
    RAISE EXCEPTION 'Rate-limit executor must have no role memberships';
  END IF;
END;
$role$;

GRANT USAGE ON SCHEMA public TO pulse_metrics_rate_limit_executor;
GRANT SELECT (action,bucket_kind,bucket_digest,attempts,window_end),
      INSERT (action,bucket_kind,bucket_digest,attempts,window_end),
      UPDATE (attempts,window_end)
  ON public.invitation_rate_limits TO pulse_metrics_rate_limit_executor;

-- Hard-coded limits: callers cannot raise quotas or change windows.
-- ISSUE:  actor 10/15m, network 60/15m.
-- ACCEPT: actor 20/15m, network 120/15m.
-- Each call consumes exactly one bucket, even when denied.
-- The backend should call network BEFORE bearer verification (subject to
-- network-address trust), then actor AFTER JWT verification.
-- Upsert locks one bucket row and serializes concurrency across app instances.
-- API role cannot read, reset, or delete counters directly.
CREATE FUNCTION public.consume_invitation_rate_limit(
  p_action text, p_bucket_kind text, p_digest text
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_limit integer;
  v_count bigint;
  v_end timestamptz;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('issue','accept')
     OR p_bucket_kind IS NULL OR p_bucket_kind NOT IN ('actor','network')
     OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid rate-limit key' USING ERRCODE='22023';
  END IF;
  IF p_action='issue' THEN
    v_limit := CASE WHEN p_bucket_kind='actor' THEN 10 ELSE 60 END;
  ELSE
    v_limit := CASE WHEN p_bucket_kind='actor' THEN 20 ELSE 120 END;
  END IF;

  INSERT INTO public.invitation_rate_limits AS bucket
    (action,bucket_kind,bucket_digest,attempts,window_end)
  VALUES (p_action,p_bucket_kind,p_digest,1,v_now + interval '15 minutes')
  ON CONFLICT (action,bucket_kind,bucket_digest) DO UPDATE
    SET attempts = CASE WHEN bucket.window_end<=v_now THEN 1
                        ELSE bucket.attempts+1 END,
        window_end = CASE WHEN bucket.window_end<=v_now
                          THEN v_now + interval '15 minutes'
                          ELSE bucket.window_end END
  RETURNING bucket.attempts,bucket.window_end INTO v_count,v_end;

  allowed := v_count <= v_limit;
  retry_after_seconds := CASE WHEN allowed THEN 0
    ELSE greatest(1,ceil(extract(epoch FROM v_end-v_now))::integer) END;
  RETURN NEXT;
END;
$function$;

ALTER FUNCTION public.consume_invitation_rate_limit(text,text,text)
  OWNER TO pulse_metrics_rate_limit_executor;
REVOKE ALL ON FUNCTION public.consume_invitation_rate_limit(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_invitation_rate_limit(text,text,text)
  TO pulse_metrics_app;
COMMIT;
