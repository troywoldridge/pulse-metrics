-- D15C-5M: FICTIONAL FIXTURES. Disposable Unix-socket PostgreSQL cluster ONLY.
-- Apply exclusively through test-monitoring-history-postgres.sh after identity guards.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL
     OR to_regprocedure('public.resolve_workos_user(text)') IS NULL THEN
    RAISE EXCEPTION 'REFUSE_D15C5M_FIXTURE_TARGET';
  END IF;
END;
$guard$;

INSERT INTO public.organizations (id, name, slug) VALUES
  ('00000000-0000-4000-8000-00000005a001', '5M Fixture Organization A', 'fixture-5m-org-a'),
  ('00000000-0000-4000-8000-00000005b001', '5M Fixture Organization B', 'fixture-5m-org-b');

INSERT INTO public.users (id, auth_provider, auth_subject) VALUES
  ('00000000-0000-4000-8000-00000005a101', 'workos', 'user_5m_alpha'),
  ('00000000-0000-4000-8000-00000005b101', 'workos', 'user_5m_beta');

INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES
  ('00000000-0000-4000-8000-00000005a001', '00000000-0000-4000-8000-00000005a101', 'viewer'),
  ('00000000-0000-4000-8000-00000005b001', '00000000-0000-4000-8000-00000005b101', 'owner');

INSERT INTO public.monitored_agents
  (id, organization_id, display_name, hostname, platform, architecture)
VALUES
  ('00000000-0000-4000-8000-00000005a201', '00000000-0000-4000-8000-00000005a001',
   '5M A Actual Data', 'a-history.fixture.invalid', 'linux', 'x86_64'),
  ('00000000-0000-4000-8000-00000005a202', '00000000-0000-4000-8000-00000005a001',
   '5M A High Volume', 'a-volume.fixture.invalid', 'linux', 'x86_64'),
  ('00000000-0000-4000-8000-00000005a203', '00000000-0000-4000-8000-00000005a001',
   '5M A No Data', 'a-empty.fixture.invalid', 'linux', 'x86_64'),
  ('00000000-0000-4000-8000-00000005b201', '00000000-0000-4000-8000-00000005b001',
   '5M B Private Data', 'b-history.fixture.invalid', 'linux', 'x86_64');

-- Only these three rows are inside the current hour for A's normal agent.
-- No network byte rates are fabricated; NULL is an honest missing value.
INSERT INTO public.telemetry_samples
  (organization_id, agent_id, recorded_at, cpu_usage_percent,
   memory_usage_percent, disk_usage_percent, metrics)
VALUES
  ('00000000-0000-4000-8000-00000005a001', '00000000-0000-4000-8000-00000005a201',
   statement_timestamp() - interval '10 minutes', 21.5, 50, 75, '{"fixture":"a-old"}'::jsonb),
  ('00000000-0000-4000-8000-00000005a001', '00000000-0000-4000-8000-00000005a201',
   statement_timestamp() - interval '5 minutes', NULL, NULL, NULL, '{"fixture":"a-unavailable"}'::jsonb),
  ('00000000-0000-4000-8000-00000005a001', '00000000-0000-4000-8000-00000005a201',
   statement_timestamp() - interval '2 minutes', 61.25, 62, 67, '{"fixture":"a-new"}'::jsonb),
  ('00000000-0000-4000-8000-00000005a001', '00000000-0000-4000-8000-00000005a201',
   statement_timestamp() - interval '8 days', 99, 99, 99, '{"fixture":"a-expired"}'::jsonb),
  ('00000000-0000-4000-8000-00000005a001', '00000000-0000-4000-8000-00000005a201',
   statement_timestamp() + interval '1 day', 88, 88, 88, '{"fixture":"a-future"}'::jsonb),
  ('00000000-0000-4000-8000-00000005b001', '00000000-0000-4000-8000-00000005b201',
   statement_timestamp() - interval '3 minutes', 98, 97, 96, '{"fixture":"b-secret"}'::jsonb);

-- 501 chronologically distinct samples within the last 15 minutes.
-- This verifies newest-500 behavior and an honest truncation flag.
INSERT INTO public.telemetry_samples
  (organization_id, agent_id, recorded_at, cpu_usage_percent, metrics)
SELECT '00000000-0000-4000-8000-00000005a001'::uuid,
       '00000000-0000-4000-8000-00000005a202'::uuid,
       statement_timestamp() - make_interval(secs => 531 - n),
       ((n % 100)::numeric + 0.5)::real,
       '{"fixture":"a-volume"}'::jsonb
FROM generate_series(1, 501) AS n;
COMMIT;
