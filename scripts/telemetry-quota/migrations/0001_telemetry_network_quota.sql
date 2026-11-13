-- Pulse Metrics D15C-3B: REVIEW-ONLY, disposable-cluster network quota.
-- DO NOT apply to development, staging, production, or customer databases.
-- Install only after D15B in a separately verified temporary PostgreSQL cluster.
-- Fixed provisional ceiling: 1,200 requests per 60 seconds per HMAC network key.
-- This is NOT an authenticated agent quota or a complete DDoS control.
-- Historical migrations and their fingerprints must remain unchanged.
\set ON_ERROR_STOP on

BEGIN;

DO $preflight$
BEGIN
  -- This deliberately refuses the ordinary local development cluster.
  -- The rehearsal must independently verify its marker and data directory.
  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('listen_addresses') <> ''
     OR current_setting('port') <> '55432'
     OR current_setting('data_directory') !~
       '^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'
     OR current_setting('unix_socket_directories') !~
       '^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$'
  THEN
    RAISE EXCEPTION
      'REFUSE_D15C_QUOTA: verified disposable PostgreSQL required'
      USING ERRCODE = '42501';
  END IF;

  IF to_regclass('public.__drizzle_migrations') IS NULL
     OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.submissions') IS NULL
     OR to_regprocedure(
       'pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'
     ) IS NULL
     OR to_regnamespace('pulse_telemetry_quota') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname = 'pulse_metrics_telemetry_quota_executor'
     )
  THEN
    RAISE EXCEPTION
      'REFUSE_D15C_QUOTA: unexpected protected database baseline'
      USING ERRCODE = '42501';
  END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (
       SELECT count(*)
       FROM pulse_security_migrations.applied_privileged_steps
     ) <> 6
     OR (
       SELECT count(*)
       FROM pulse_telemetry_ingestion.schema_migrations
     ) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pulse_telemetry_ingestion.schema_migrations
       WHERE version = '0001'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_class
       WHERE oid = 'pulse_telemetry_ingestion.schema_migrations'::regclass
         AND relrowsecurity AND relforcerowsecurity
     )
     OR has_table_privilege(
       'pulse_metrics_app', 'public.agent_credentials', 'SELECT'
     )
     OR has_any_column_privilege(
       'pulse_metrics_app', 'public.telemetry_samples', 'INSERT'
     )
  THEN
    RAISE EXCEPTION
      'REFUSE_D15C_QUOTA: migration ledger or runtime grants invalid'
      USING ERRCODE = '42501';
  END IF;
END;
$preflight$;

-- Quotas are a separate security domain from enrollment and ingestion.
CREATE SCHEMA pulse_telemetry_quota;
REVOKE ALL ON SCHEMA pulse_telemetry_quota FROM PUBLIC;

-- A private atomic migration receipt, unreadable by the application role.
CREATE TABLE pulse_telemetry_quota.schema_migrations (
  version varchar(16) PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  description varchar(160) NOT NULL
);
ALTER TABLE pulse_telemetry_quota.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_telemetry_quota.schema_migrations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pulse_telemetry_quota.schema_migrations
  FROM PUBLIC, pulse_metrics_app;

-- Only opaque HMAC digests are persisted: no raw network addresses.
CREATE TABLE pulse_telemetry_quota.network_buckets (
  bucket_digest text PRIMARY KEY
    CHECK (bucket_digest ~ '^[0-9a-f]{64}$'),
  attempts bigint NOT NULL CHECK (attempts >= 1),
  window_end timestamptz NOT NULL
);
CREATE INDEX network_buckets_expiry_idx
  ON pulse_telemetry_quota.network_buckets(window_end);
ALTER TABLE pulse_telemetry_quota.network_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_telemetry_quota.network_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pulse_telemetry_quota.network_buckets
  FROM PUBLIC, pulse_metrics_app;

-- Dedicated non-login owner; never grant this role to application users.
-- BYPASSRLS affects only tables this role can otherwise access.
CREATE ROLE pulse_metrics_telemetry_quota_executor
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION BYPASSRLS;

GRANT USAGE ON SCHEMA pulse_telemetry_quota
  TO pulse_metrics_app, pulse_metrics_telemetry_quota_executor;
GRANT SELECT (bucket_digest, attempts, window_end),
      INSERT (bucket_digest, attempts, window_end),
      UPDATE (attempts, window_end)
  ON pulse_telemetry_quota.network_buckets
  TO pulse_metrics_telemetry_quota_executor;

-- Caller cannot select the threshold, duration, key namespace or timestamp.
-- INSERT ... ON CONFLICT is atomic across concurrent API connections.
CREATE FUNCTION pulse_telemetry_quota.consume_network_quota(
  p_digest text
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count bigint;
  v_end timestamptz;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid network quota input'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO pulse_telemetry_quota.network_buckets AS bucket
    (bucket_digest, attempts, window_end)
  VALUES (p_digest, 1, v_now + interval '60 seconds')
  ON CONFLICT (bucket_digest) DO UPDATE
  SET attempts = CASE
        WHEN bucket.window_end <= v_now THEN 1
        WHEN bucket.attempts < 9223372036854775807::bigint
          THEN bucket.attempts + 1
        ELSE bucket.attempts
      END,
      window_end = CASE
        WHEN bucket.window_end <= v_now
          THEN v_now + interval '60 seconds'
        ELSE bucket.window_end
      END
  RETURNING bucket.attempts, bucket.window_end INTO v_count, v_end;

  allowed := v_count <= 1200;
  retry_after_seconds := CASE
    WHEN allowed THEN 0
    ELSE greatest(
      1,
      least(900, ceil(extract(epoch FROM v_end - v_now))::integer)
    )
  END;
  RETURN NEXT;
END;
$function$;

ALTER FUNCTION pulse_telemetry_quota.consume_network_quota(text)
  OWNER TO pulse_metrics_telemetry_quota_executor;
REVOKE ALL ON FUNCTION pulse_telemetry_quota.consume_network_quota(text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_telemetry_quota.consume_network_quota(text)
  TO pulse_metrics_app;

-- Confirm direct table access is denied to the ordinary runtime role.
DO $postflight$
BEGIN
  IF has_any_column_privilege(
       'pulse_metrics_app', 'pulse_telemetry_quota.network_buckets', 'SELECT'
     )
     OR has_any_column_privilege(
       'pulse_metrics_app', 'pulse_telemetry_quota.network_buckets', 'INSERT'
     )
     OR has_any_column_privilege(
       'pulse_metrics_app', 'pulse_telemetry_quota.network_buckets', 'UPDATE'
     )
     OR has_table_privilege(
       'pulse_metrics_app', 'pulse_telemetry_quota.network_buckets', 'DELETE'
     )
     OR has_table_privilege(
       'pulse_metrics_app', 'pulse_telemetry_quota.schema_migrations', 'SELECT'
     )
     OR pg_has_role(
       'pulse_metrics_app', 'pulse_metrics_telemetry_quota_executor', 'MEMBER'
     )
  THEN
    RAISE EXCEPTION
      'REFUSE_D15C_QUOTA: runtime quota table access detected'
      USING ERRCODE = '42501';
  END IF;
END;
$postflight$;

INSERT INTO pulse_telemetry_quota.schema_migrations(version, description)
VALUES ('0001', 'D15C-3B isolated network quota candidate');

COMMIT;
