-- Pulse Metrics Phase 2E3C5D10: VERSIONED, REVIEW-ONLY ingress quota candidate.
-- Never apply automatically to a working or customer database.
-- Apply only using the isolated harness after original six steps + D9 0001.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF current_database()<>'pulse_metrics' OR current_user<>'postgres'
    OR to_regnamespace('pulse_agent_enrollment') IS NULL
    OR to_regclass('pulse_agent_enrollment.schema_migrations') IS NULL
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations WHERE version='0001')<>1
    OR EXISTS (SELECT 1 FROM pulse_agent_enrollment.schema_migrations WHERE version='0002')
    OR to_regclass('pulse_agent_enrollment.ingress_rate_limits') IS NOT NULL
    OR to_regprocedure('pulse_agent_enrollment.consume_ingress_quota(text,text,text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_agent_ingress_executor')
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6
    OR (SELECT count(*) FROM public.__drizzle_migrations)<>1 THEN
    RAISE EXCEPTION 'REFUSE_D10: expected fresh D9 migration in reviewed database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='pulse_agent_enrollment.schema_migrations'::regclass
    AND relrowsecurity AND relforcerowsecurity AND relowner='postgres'::regrole)
    OR has_table_privilege('pulse_metrics_app','pulse_agent_enrollment.schema_migrations','SELECT')
    OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
    OR has_table_privilege('pulse_metrics_app','public.agent_enrollment_tokens','SELECT') THEN
    RAISE EXCEPTION 'REFUSE_D10: baseline role/grant or ledger invariant invalid';
  END IF;
END;
$guard$;

-- A single transaction contains the SQL objects AND the receipt.
CREATE TABLE pulse_agent_enrollment.ingress_rate_limits (
  action varchar(12) NOT NULL,
  bucket_kind varchar(12) NOT NULL,
  bucket_digest varchar(64) NOT NULL,
  attempts bigint NOT NULL,
  window_end timestamptz NOT NULL,
  CONSTRAINT ingress_rate_limits_pk PRIMARY KEY (action,bucket_kind,bucket_digest),
  CONSTRAINT ingress_rate_limits_action_kind CHECK (
    (action='issue' AND bucket_kind IN ('actor','network')) OR
    (action='redeem' AND bucket_kind='network')),
  CONSTRAINT ingress_rate_limits_digest CHECK (bucket_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ingress_rate_limits_attempts CHECK (attempts>=1)
);
CREATE INDEX ingress_rate_limits_window_end_idx
  ON pulse_agent_enrollment.ingress_rate_limits(window_end);
ALTER TABLE pulse_agent_enrollment.ingress_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_agent_enrollment.ingress_rate_limits FORCE ROW LEVEL SECURITY;
-- No RLS policies, no direct runtime access. Expiry cleanup is a future
-- separately approved DB maintenance task; these rows contain HMAC digests.

CREATE ROLE pulse_metrics_agent_ingress_executor
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
GRANT USAGE ON SCHEMA pulse_agent_enrollment TO pulse_metrics_agent_ingress_executor;
GRANT SELECT (action,bucket_kind,bucket_digest,attempts,window_end),
      INSERT (action,bucket_kind,bucket_digest,attempts,window_end),
      UPDATE (attempts,window_end)
  ON pulse_agent_enrollment.ingress_rate_limits TO pulse_metrics_agent_ingress_executor;

-- Fixed, per-action limits: issue network 40/15 min; issue actor 8/15 min;
-- redeem network 25/15 min. Caller CANNOT increase ceilings or windows.
-- Atomic UPSERT serializes concurrent requests across API instances.
CREATE FUNCTION pulse_agent_enrollment.consume_ingress_quota(
  p_action text, p_kind text, p_digest text
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_limit integer;
  v_count bigint;
  v_end timestamptz;
BEGIN
  IF p_action IS NULL OR p_kind IS NULL OR
     NOT ((p_action='issue' AND p_kind IN ('actor','network')) OR
          (p_action='redeem' AND p_kind='network')) OR
     p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid quota input' USING ERRCODE='22023';
  END IF;
  v_limit := CASE
    WHEN p_action='issue' AND p_kind='actor' THEN 8
    WHEN p_action='issue' AND p_kind='network' THEN 40
    ELSE 25
  END;
  INSERT INTO pulse_agent_enrollment.ingress_rate_limits AS bucket
    (action,bucket_kind,bucket_digest,attempts,window_end)
  VALUES (p_action,p_kind,p_digest,1,v_now+interval '15 minutes')
  ON CONFLICT (action,bucket_kind,bucket_digest) DO UPDATE
  SET attempts=CASE WHEN bucket.window_end<=v_now THEN 1
                    ELSE CASE WHEN bucket.attempts=9223372036854775807::bigint
                              THEN bucket.attempts ELSE bucket.attempts+1 END END,
      window_end=CASE WHEN bucket.window_end<=v_now
                       THEN v_now+interval '15 minutes' ELSE bucket.window_end END
  RETURNING bucket.attempts,bucket.window_end INTO v_count,v_end;
  allowed := v_count<=v_limit;
  retry_after_seconds := CASE WHEN allowed THEN 0
    ELSE greatest(1,least(900,ceil(extract(epoch FROM v_end-v_now))::integer)) END;
  RETURN NEXT;
END;
$fn$;
ALTER FUNCTION pulse_agent_enrollment.consume_ingress_quota(text,text,text)
  OWNER TO pulse_metrics_agent_ingress_executor;
REVOKE ALL ON FUNCTION pulse_agent_enrollment.consume_ingress_quota(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_agent_enrollment.consume_ingress_quota(text,text,text)
  TO pulse_metrics_app;

INSERT INTO pulse_agent_enrollment.schema_migrations(version,description)
VALUES ('0002','Versioned agent ingress distributed quota boundary');
COMMIT;
