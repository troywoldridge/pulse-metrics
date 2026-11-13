-- Pulse Metrics D15C-4B: REVIEW-ONLY authenticated-agent quota candidate.
-- NEVER apply to ordinary development, staging, production, or customer databases.
-- Installs ONLY in a marker-verified disposable Unix-socket PostgreSQL cluster.
-- Original Drizzle, six privileged steps, enrollment, D15B and D15C-3 source
-- files remain byte-identical. No HTTP endpoints are activated.
-- Fixed provisional agent allowance: 120 chargeable attempts / 60 seconds.
-- Exact authenticated duplicates are free; conflicts are chargeable.
-- Caller MUST execute ingestion as a standalone, autocommit SQL statement.
\set ON_ERROR_STOP on
BEGIN;

DO $preflight$
DECLARE
  v_previous pg_catalog.text;
BEGIN
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
    RAISE EXCEPTION 'REFUSE_D15C4: disposable PostgreSQL required'
      USING ERRCODE='42501';
  END IF;

  IF to_regclass('public.__drizzle_migrations') IS NULL
     OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_quota.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_quota.network_buckets') IS NULL
     OR to_regprocedure(
       'pulse_telemetry_quota.consume_network_quota(text)'
     ) IS NULL
     OR to_regclass('pulse_telemetry_ingestion.submissions') IS NULL
     OR to_regnamespace('pulse_telemetry_agent_quota') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_roles
       WHERE rolname='pulse_metrics_telemetry_agent_quota_executor')
  THEN
    RAISE EXCEPTION 'REFUSE_D15C4: migration prerequisite missing or replay'
      USING ERRCODE='42501';
  END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_ingestion.schema_migrations
                    WHERE version='0001')
     OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_quota.schema_migrations
                    WHERE version='0001')
     OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_ingestion.submissions','SELECT')
     OR pg_has_role('pulse_metrics_app','pulse_metrics_telemetry_executor','MEMBER')
  THEN
    RAISE EXCEPTION 'REFUSE_D15C4: protected baseline permission regression'
      USING ERRCODE='42501';
  END IF;

  -- Pin the installed D15B function BODY, not only the receipt. Refuse
  -- if any SQL or function ownership has drifted since the reviewed 0001.
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')
    INTO v_previous
  FROM pg_catalog.pg_proc p
  WHERE p.oid = to_regprocedure(
    'pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'
  )
    AND p.prosecdef
    AND p.proowner = 'pulse_metrics_telemetry_executor'::regrole
    AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF v_previous IS DISTINCT FROM '588783991e63bc975f774692fc6732c80ac2e9070b33c93bea43c503e31f2f1f' THEN
    RAISE EXCEPTION 'REFUSE_D15C4: D15B function fingerprint changed'
      USING ERRCODE='42501';
  END IF;
END;
$preflight$;

-- Isolated private namespace: the app cannot even resolve its tables.
CREATE SCHEMA pulse_telemetry_agent_quota;
REVOKE ALL ON SCHEMA pulse_telemetry_agent_quota FROM PUBLIC, pulse_metrics_app;

CREATE TABLE pulse_telemetry_agent_quota.schema_migrations (
  version varchar(16) PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  description varchar(160) NOT NULL
);
ALTER TABLE pulse_telemetry_agent_quota.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_telemetry_agent_quota.schema_migrations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pulse_telemetry_agent_quota.schema_migrations
  FROM PUBLIC, pulse_metrics_app;

-- Internal, database-derived tenant/agent IDs; never caller supplied.
CREATE TABLE pulse_telemetry_agent_quota.agent_buckets (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  attempts bigint NOT NULL CHECK (attempts >= 1),
  window_end timestamptz NOT NULL,
  PRIMARY KEY (organization_id, agent_id)
);
CREATE INDEX agent_buckets_window_end_idx
  ON pulse_telemetry_agent_quota.agent_buckets(window_end);
ALTER TABLE pulse_telemetry_agent_quota.agent_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_telemetry_agent_quota.agent_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pulse_telemetry_agent_quota.agent_buckets
  FROM PUBLIC, pulse_metrics_app;

CREATE ROLE pulse_metrics_telemetry_agent_quota_executor
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION BYPASSRLS;
GRANT USAGE ON SCHEMA pulse_telemetry_agent_quota
  TO pulse_metrics_telemetry_agent_quota_executor,
     pulse_metrics_telemetry_executor;
GRANT SELECT (organization_id,agent_id,attempts,window_end),
      INSERT (organization_id,agent_id,attempts,window_end),
      UPDATE (attempts,window_end)
  ON pulse_telemetry_agent_quota.agent_buckets
  TO pulse_metrics_telemetry_agent_quota_executor;

-- This SECURITY DEFINER function is accessible ONLY through the
-- protected D15B ingestion function owner (a NOLOGIN restricted role).
-- The app has no direct USAGE on this schema and no EXECUTE on this function.
CREATE FUNCTION pulse_telemetry_agent_quota.consume_new_submission(
  p_organization_id uuid, p_agent_id uuid
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $quota$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count bigint;
  v_end timestamptz;
BEGIN
  IF p_organization_id IS NULL OR p_agent_id IS NULL THEN
    RAISE EXCEPTION 'Invalid internal quota identity'
      USING ERRCODE='22023';
  END IF;

  -- Atomic UPSERT serializes all concurrent submissions from this agent,
  -- even when those requests hit different application workers.
  INSERT INTO pulse_telemetry_agent_quota.agent_buckets AS b
    (organization_id,agent_id,attempts,window_end)
  VALUES (p_organization_id,p_agent_id,1,v_now+interval '60 seconds')
  ON CONFLICT (organization_id,agent_id) DO UPDATE
  SET attempts = CASE WHEN b.window_end <= v_now THEN 1
      WHEN b.attempts = 9223372036854775807::bigint THEN b.attempts
      ELSE b.attempts + 1 END,
      window_end = CASE WHEN b.window_end <= v_now
        THEN v_now + interval '60 seconds' ELSE b.window_end END
  RETURNING b.attempts,b.window_end INTO v_count,v_end;

  allowed := (v_count <= 120);
  retry_after_seconds := CASE WHEN allowed THEN 0
    ELSE greatest(1, least(60, ceil(extract(epoch FROM v_end-v_now))::integer)) END;
  RETURN NEXT;
END;
$quota$;

ALTER FUNCTION pulse_telemetry_agent_quota.consume_new_submission(uuid,uuid)
  OWNER TO pulse_metrics_telemetry_agent_quota_executor;
REVOKE ALL ON FUNCTION pulse_telemetry_agent_quota.consume_new_submission(uuid,uuid)
  FROM PUBLIC, pulse_metrics_app;
GRANT EXECUTE ON FUNCTION pulse_telemetry_agent_quota.consume_new_submission(uuid,uuid)
  TO pulse_metrics_telemetry_executor;

-- Full D15B function body retained, with a minimally scoped quota check
-- injected only after locked authorization and duplicate handling.
-- CREATE OR REPLACE retains original function OID/owner/ACL/signature.

CREATE OR REPLACE FUNCTION pulse_telemetry_ingestion.ingest_submission(
  p_credential_hash text,
  p_submission_id uuid,
  p_payload_sha256 text,
  p_recorded_at timestamptz,
  p_schema_version integer,
  p_cpu real,
  p_memory real,
  p_disk real,
  p_network_rx bigint,
  p_network_tx bigint,
  p_metrics jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_identity record;
  v_conflict boolean := false;
  v_quota_allowed boolean;
  v_quota_retry integer;
  v_credential record;
  v_agent_status public.agent_status;
  v_previous record;
  v_sample_id bigint;
  v_name text;
  v_sample jsonb;
  v_unit text;
  v_status text;
  v_value numeric;
  v_observed_at timestamptz;
  v_expected_cpu real;
  v_expected_memory real;
  v_expected_disk real;
  v_total numeric;
  v_available numeric;
BEGIN
  -- Validate all scalar parameters independently of TypeScript.
  IF p_credential_hash IS NULL
     OR p_credential_hash !~ '^[0-9a-f]{64}$'
     OR p_submission_id IS NULL
     OR p_submission_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_payload_sha256 IS NULL
     OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR p_recorded_at IS NULL
     OR p_schema_version IS DISTINCT FROM 1
     OR p_metrics IS NULL
     OR jsonb_typeof(p_metrics) IS DISTINCT FROM 'object'
     OR octet_length(p_metrics::text) > 65536
     OR p_network_rx IS NOT NULL
     OR p_network_tx IS NOT NULL
     OR p_recorded_at < clock_timestamp() - interval '24 hours'
     OR p_recorded_at > clock_timestamp() + interval '5 minutes'
     OR p_cpu::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_memory::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_disk::text IN ('NaN', 'Infinity', '-Infinity')
     OR (p_cpu IS NOT NULL AND (p_cpu < 0 OR p_cpu > 100))
     OR (p_memory IS NOT NULL AND (p_memory < 0 OR p_memory > 100))
     OR (p_disk IS NOT NULL AND (p_disk < 0 OR p_disk > 100))
  THEN
    RAISE EXCEPTION 'Invalid telemetry submission'
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*) FROM jsonb_each(p_metrics))
       NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid telemetry metrics'
      USING ERRCODE = '22023';
  END IF;

  -- Validate every metric. No status, timestamp or unit may be omitted.
  FOR v_name, v_sample IN
    SELECT key, value FROM jsonb_each(p_metrics)
  LOOP
    v_unit := CASE
      WHEN v_name = 'cpu.usage_percent' THEN 'percent'
      WHEN v_name = 'cpu.core_count' THEN 'cores'
      WHEN v_name IN (
        'cpu.load_1m', 'cpu.load_5m', 'cpu.load_15m'
      ) THEN 'load'
      WHEN v_name IN (
        'memory.total_bytes', 'memory.available_bytes',
        'swap.total_bytes', 'swap.free_bytes',
        'disk.root.total_bytes', 'disk.root.available_bytes',
        'network.received_bytes', 'network.transmitted_bytes'
      ) THEN 'bytes'
      WHEN v_name = 'system.uptime_seconds' THEN 'seconds'
      ELSE NULL
    END;

    IF v_unit IS NULL
       OR jsonb_typeof(v_sample) IS DISTINCT FROM 'object'
    THEN
      RAISE EXCEPTION 'Invalid telemetry metric structure'
        USING ERRCODE = '22023';
    END IF;

    IF v_sample->>'metric' IS DISTINCT FROM v_name
       OR v_sample->>'unit' IS DISTINCT FROM v_unit
       OR coalesce(v_sample->>'status', '') NOT IN (
         'measured', 'stale', 'unavailable', 'unsupported'
       )
       OR jsonb_typeof(v_sample->'metric') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_sample->'unit') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_sample->'status') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_sample->'observedAt') IS DISTINCT FROM 'string'
       OR coalesce(v_sample->>'observedAt', '') !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       OR NOT (v_sample ? 'value')
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_sample) AS k(key)
         WHERE k.key NOT IN (
           'metric', 'value', 'unit', 'observedAt',
           'status', 'source', 'reason'
         )
       )
       OR (
         v_sample ? 'source'
         AND (
           jsonb_typeof(v_sample->'source') IS DISTINCT FROM 'string'
           OR char_length(v_sample->>'source') > 256
         )
       )
       OR (
         v_sample ? 'reason'
         AND (
           jsonb_typeof(v_sample->'reason') IS DISTINCT FROM 'string'
           OR char_length(v_sample->>'reason') > 256
         )
       )
    THEN
      RAISE EXCEPTION 'Invalid telemetry metric structure'
        USING ERRCODE = '22023';
    END IF;

    -- A malformed timestamp must fail closed, not be silently ignored.
    BEGIN
      v_observed_at := (v_sample->>'observedAt')::timestamptz;
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'Invalid observation time'
          USING ERRCODE = '22023';
    END;

    IF v_observed_at < clock_timestamp() - interval '24 hours'
       OR v_observed_at > clock_timestamp() + interval '5 minutes'
       OR v_observed_at > p_recorded_at + interval '5 minutes'
    THEN
      RAISE EXCEPTION 'Invalid observation time'
        USING ERRCODE = '22023';
    END IF;

    v_status := v_sample->>'status';

    IF v_status IN ('unavailable', 'unsupported') THEN
      IF jsonb_typeof(v_sample->'value') IS DISTINCT FROM 'null' THEN
        RAISE EXCEPTION 'Unavailable metric has a value'
          USING ERRCODE = '22023';
      END IF;
    ELSE
      IF jsonb_typeof(v_sample->'value') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Measured metric lacks numeric value'
          USING ERRCODE = '22023';
      END IF;

      v_value := (v_sample->>'value')::numeric;

      IF v_value < 0
         OR v_value > 9007199254740991
         OR (v_name = 'cpu.usage_percent' AND v_value > 100)
         OR (
           v_name = 'cpu.core_count'
           AND (v_value < 1 OR v_value <> trunc(v_value))
         )
         OR (
           v_unit = 'bytes' AND v_value <> trunc(v_value)
         )
      THEN
        RAISE EXCEPTION 'Invalid telemetry metric value'
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;

  -- Derive summary values again inside PostgreSQL.
  -- Stale and unavailable samples never become current summaries.
  v_expected_cpu := NULL;
  IF p_metrics->'cpu.usage_percent'->>'status' = 'measured' THEN
    v_expected_cpu :=
      (p_metrics->'cpu.usage_percent'->>'value')::real;
  END IF;

  v_expected_memory := NULL;
  IF p_metrics->'memory.total_bytes'->>'status' = 'measured'
     AND p_metrics->'memory.available_bytes'->>'status' = 'measured'
  THEN
    v_total := (p_metrics->'memory.total_bytes'->>'value')::numeric;
    v_available :=
      (p_metrics->'memory.available_bytes'->>'value')::numeric;

    IF v_total > 0 AND v_available <= v_total THEN
      v_expected_memory :=
        ((v_total - v_available) * 100 / v_total)::real;
    END IF;
  END IF;

  v_expected_disk := NULL;
  IF p_metrics->'disk.root.total_bytes'->>'status' = 'measured'
     AND p_metrics->'disk.root.available_bytes'->>'status' = 'measured'
  THEN
    v_total := (p_metrics->'disk.root.total_bytes'->>'value')::numeric;
    v_available :=
      (p_metrics->'disk.root.available_bytes'->>'value')::numeric;

    IF v_total > 0 AND v_available <= v_total THEN
      v_expected_disk :=
        ((v_total - v_available) * 100 / v_total)::real;
    END IF;
  END IF;

  IF (p_cpu IS NULL) <> (v_expected_cpu IS NULL)
     OR (p_memory IS NULL) <> (v_expected_memory IS NULL)
     OR (p_disk IS NULL) <> (v_expected_disk IS NULL)
     OR (
       p_cpu IS NOT NULL AND v_expected_cpu IS NOT NULL
       AND abs(p_cpu - v_expected_cpu) > 0.001
     )
     OR (
       p_memory IS NOT NULL AND v_expected_memory IS NOT NULL
       AND abs(p_memory - v_expected_memory) > 0.001
     )
     OR (
       p_disk IS NOT NULL AND v_expected_disk IS NOT NULL
       AND abs(p_disk - v_expected_disk) > 0.001
     )
  THEN
    RAISE EXCEPTION 'Telemetry summary mismatch'
      USING ERRCODE = '22023';
  END IF;

  -- Resolve identity from the credential hash alone.
  SELECT c.organization_id, c.agent_id
    INTO v_identity
  FROM public.agent_credentials c
  WHERE c.token_hash = p_credential_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Machine credential unavailable'
      USING ERRCODE = '42501';
  END IF;

  -- Match administrative lock ordering: agent BEFORE credential.
  -- FOR SHARE conflicts with the FOR UPDATE lock used by revocation.
  SELECT a.status INTO v_agent_status
  FROM public.monitored_agents a
  WHERE a.organization_id = v_identity.organization_id
    AND a.id = v_identity.agent_id
  FOR SHARE;

  IF NOT FOUND OR v_agent_status <> 'active' THEN
    RAISE EXCEPTION 'Machine credential unavailable'
      USING ERRCODE = '42501';
  END IF;

  -- Recheck current credential state AFTER acquiring the agent lock.
  SELECT c.id, c.organization_id, c.agent_id INTO v_credential
  FROM public.agent_credentials c
  WHERE c.token_hash = p_credential_hash
    AND c.organization_id = v_identity.organization_id
    AND c.agent_id = v_identity.agent_id
    AND c.revoked_at IS NULL
    AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
    AND c.scopes @> '["telemetry:write"]'::jsonb
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Machine credential unavailable'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize concurrent retries of a submission.
  -- The PRIMARY KEY is the final uniqueness enforcement.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_identity.organization_id::text || ':' ||
      v_identity.agent_id::text || ':' ||
      p_submission_id::text,
      0
    )
  );

  SELECT s.payload_sha256, t.recorded_at, t.schema_version,
         t.cpu_usage_percent, t.memory_usage_percent,
         t.disk_usage_percent,
         t.network_receive_bytes_per_second,
         t.network_transmit_bytes_per_second, t.metrics
    INTO v_previous
  FROM pulse_telemetry_ingestion.submissions s
  JOIN public.telemetry_samples t
    ON t.id = s.telemetry_sample_id
  WHERE s.organization_id = v_identity.organization_id
    AND s.agent_id = v_identity.agent_id
    AND s.submission_id = p_submission_id;

  IF FOUND THEN
    IF v_previous.payload_sha256 = p_payload_sha256
       AND v_previous.recorded_at = p_recorded_at
       AND v_previous.schema_version = p_schema_version
       AND v_previous.cpu_usage_percent IS NOT DISTINCT FROM p_cpu
       AND v_previous.memory_usage_percent IS NOT DISTINCT FROM p_memory
       AND v_previous.disk_usage_percent IS NOT DISTINCT FROM p_disk
       AND v_previous.network_receive_bytes_per_second
           IS NOT DISTINCT FROM p_network_rx
       AND v_previous.network_transmit_bytes_per_second
           IS NOT DISTINCT FROM p_network_tx
       AND v_previous.metrics = p_metrics
    THEN
      RETURN 'duplicate';
    END IF;

    -- A reused submission ID with different contents is a chargeable
    -- attempt. Never overwrite or disclose the original submission.
    v_conflict := true;
  END IF;

  -- Authenticated agent quota: called ONLY after locked credential
  -- authorization and exact-duplicate recognition. There is no
  -- client-controlled tenant or agent identifier in this call.
  SELECT q.allowed, q.retry_after_seconds
    INTO STRICT v_quota_allowed, v_quota_retry
  FROM pulse_telemetry_agent_quota.consume_new_submission(
    v_identity.organization_id, v_identity.agent_id
  ) AS q;

  IF v_quota_allowed IS NULL OR v_quota_retry IS NULL
     OR (v_quota_allowed AND v_quota_retry <> 0)
     OR (NOT v_quota_allowed AND (v_quota_retry < 1 OR v_quota_retry > 60))
  THEN
    RAISE EXCEPTION 'Invalid internal quota decision'
      USING ERRCODE = '22023';
  END IF;

  -- Quota denial MUST be a normal result so its counter survives
  -- statement autocommit. Never throw solely due to rate exhaustion.
  IF NOT v_quota_allowed THEN
    RETURN 'rate_limited:' || v_quota_retry::text;
  END IF;

  IF v_conflict THEN
    RETURN 'conflict';
  END IF;

  INSERT INTO public.telemetry_samples (
    organization_id, agent_id, recorded_at,
    schema_version, cpu_usage_percent,
    memory_usage_percent, disk_usage_percent,
    network_receive_bytes_per_second,
    network_transmit_bytes_per_second, metrics
  )
  VALUES (
    v_identity.organization_id, v_identity.agent_id,
    p_recorded_at, p_schema_version, p_cpu, p_memory,
    p_disk, p_network_rx, p_network_tx, p_metrics
  )
  RETURNING id INTO v_sample_id;

  INSERT INTO pulse_telemetry_ingestion.submissions (
    organization_id, agent_id, submission_id,
    payload_sha256, telemetry_sample_id
  )
  VALUES (
    v_identity.organization_id, v_identity.agent_id,
    p_submission_id, p_payload_sha256, v_sample_id
  );

  RETURN 'inserted';
END;
$function$;

-- Verify the transformed function is still a protected SECURITY DEFINER.
DO $postflight$
DECLARE
  v_updated text;
BEGIN
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')
    INTO v_updated
  FROM pg_catalog.pg_proc p
  WHERE p.oid = 'pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'::regprocedure
    AND p.prosecdef
    AND p.proowner = 'pulse_metrics_telemetry_executor'::regrole
    AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF v_updated IS DISTINCT FROM '6ca2ea99b727df12e737593d31a96238d98d81df6d2f461cdbad902002888e28'
     OR NOT has_function_privilege('pulse_metrics_app',
        'pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)', 'EXECUTE')
     OR has_function_privilege('pulse_metrics_app',
        'pulse_telemetry_agent_quota.consume_new_submission(uuid,uuid)', 'EXECUTE')
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_agent_quota','USAGE')
     OR has_any_column_privilege('pulse_metrics_app',
         'pulse_telemetry_agent_quota.agent_buckets','SELECT')
     OR has_any_column_privilege('pulse_metrics_app',
         'pulse_telemetry_agent_quota.agent_buckets','INSERT')
     OR has_any_column_privilege('pulse_metrics_app',
         'pulse_telemetry_agent_quota.agent_buckets','UPDATE')
     OR pg_has_role('pulse_metrics_app',
        'pulse_metrics_telemetry_agent_quota_executor','MEMBER')
  THEN
    RAISE EXCEPTION 'REFUSE_D15C4: unsafe function or quota ACL'
      USING ERRCODE='42501';
  END IF;
END;
$postflight$;

INSERT INTO pulse_telemetry_agent_quota.schema_migrations(version,description)
VALUES ('0001','D15C-4B authenticated agent quota, reviewed candidate');

COMMIT;
