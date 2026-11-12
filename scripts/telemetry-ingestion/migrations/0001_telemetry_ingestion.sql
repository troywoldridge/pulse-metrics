-- Pulse Metrics D15B: telemetry ingestion migration candidate.
-- REVIEW ONLY. Do not apply to ordinary development or production databases.
-- Requires existing Drizzle and protected enrollment migrations.
-- Historical migration source files must remain unchanged.
\set ON_ERROR_STOP on

BEGIN;

DO $preflight$
BEGIN
  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'REFUSE_TELEMETRY_MIGRATION: isolated database DBA required';
  END IF;

  IF to_regclass('public.telemetry_samples') IS NULL
     OR to_regclass('public.agent_credentials') IS NULL
     OR to_regclass('public.monitored_agents') IS NULL
     OR to_regprocedure(
       'pulse_agent_enrollment.verify_credential(text)'
     ) IS NULL
     OR to_regnamespace('pulse_telemetry_ingestion') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname = 'pulse_metrics_telemetry_executor'
     ) THEN
    RAISE EXCEPTION
      'REFUSE_TELEMETRY_MIGRATION: unexpected database baseline';
  END IF;
END;
$preflight$;

CREATE SCHEMA pulse_telemetry_ingestion;
REVOKE ALL ON SCHEMA pulse_telemetry_ingestion FROM PUBLIC;

CREATE ROLE pulse_metrics_telemetry_executor
  NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;

GRANT USAGE ON SCHEMA public
  TO pulse_metrics_telemetry_executor;

GRANT USAGE ON SCHEMA pulse_telemetry_ingestion
  TO pulse_metrics_app, pulse_metrics_telemetry_executor;

-- Only the dedicated function owner may inspect credential data.
GRANT SELECT (
  id, organization_id, agent_id, token_hash,
  scopes, revoked_at, expires_at
) ON public.agent_credentials
  TO pulse_metrics_telemetry_executor;

-- Required for SELECT ... FOR SHARE during atomic ingestion.
-- The ordinary application role receives no UPDATE permission.
GRANT UPDATE (revoked_at)
  ON public.agent_credentials
  TO pulse_metrics_telemetry_executor;

GRANT SELECT (
  id, organization_id, status
) ON public.monitored_agents
  TO pulse_metrics_telemetry_executor;

-- Required to lock the agent row before inspecting credentials.
-- This dedicated NOLOGIN role is not granted to app users.
GRANT UPDATE (status)
  ON public.monitored_agents
  TO pulse_metrics_telemetry_executor;

GRANT SELECT (
  id, organization_id, agent_id, recorded_at,
  schema_version, cpu_usage_percent,
  memory_usage_percent, disk_usage_percent,
  network_receive_bytes_per_second,
  network_transmit_bytes_per_second, metrics
) ON public.telemetry_samples
  TO pulse_metrics_telemetry_executor;

GRANT INSERT (
  organization_id, agent_id, recorded_at,
  schema_version, cpu_usage_percent,
  memory_usage_percent, disk_usage_percent,
  network_receive_bytes_per_second,
  network_transmit_bytes_per_second, metrics
) ON public.telemetry_samples
  TO pulse_metrics_telemetry_executor;

GRANT USAGE ON SEQUENCE public.telemetry_samples_id_seq
  TO pulse_metrics_telemetry_executor;

-- This ledger is managed by the privileged telemetry migration series.
-- It must never be exposed through an ordinary application table grant.
CREATE TABLE pulse_telemetry_ingestion.submissions (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  payload_sha256 text NOT NULL
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  telemetry_sample_id bigint NOT NULL UNIQUE
    REFERENCES public.telemetry_samples(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, agent_id, submission_id),
  FOREIGN KEY (organization_id, agent_id)
    REFERENCES public.monitored_agents(organization_id, id)
    ON DELETE RESTRICT
);

ALTER TABLE pulse_telemetry_ingestion.submissions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_telemetry_ingestion.submissions
  FORCE ROW LEVEL SECURITY;

REVOKE ALL ON pulse_telemetry_ingestion.submissions FROM PUBLIC;
GRANT SELECT, INSERT ON pulse_telemetry_ingestion.submissions
  TO pulse_metrics_telemetry_executor;

CREATE FUNCTION pulse_telemetry_ingestion.ingest_submission(
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

ALTER FUNCTION pulse_telemetry_ingestion.ingest_submission(
  text,uuid,text,timestamptz,integer,
  real,real,real,bigint,bigint,jsonb
) OWNER TO pulse_metrics_telemetry_executor;

REVOKE ALL ON FUNCTION pulse_telemetry_ingestion.ingest_submission(
  text,uuid,text,timestamptz,integer,
  real,real,real,bigint,bigint,jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pulse_telemetry_ingestion.ingest_submission(
  text,uuid,text,timestamptz,integer,
  real,real,real,bigint,bigint,jsonb
) TO pulse_metrics_app;

COMMIT;
