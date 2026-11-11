-- Phase 2E3C5C1: record ONE successfully executed original admin SQL step.
-- Only the isolated replay wrapper supplies these verified psql variables.
-- IMPORTANT: the original admin SQL includes its own BEGIN/COMMIT. This is a
-- separate receipt, not a crash-atomic joint transaction with that script.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('pulse.replay_step_version', :'version', true);
DO $guard$
DECLARE
  v_version text := current_setting('pulse.replay_step_version',true);
  v_signature text;
  v_owner text;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Only isolated postgres administrator may record replay';
  END IF;
  SELECT signature, owner INTO v_signature, v_owner
  FROM (VALUES
    ('001','public.resolve_workos_user(text)','pulse_metrics_identity_executor'),
    ('002','public.create_workos_organization(text,text,text)','pulse_metrics_onboarding_executor'),
    ('003','public.issue_organization_invitation(text,uuid,text,text,text,timestamptz)','pulse_metrics_invitation_executor'),
    ('004','public.accept_organization_invitation(text,text)','pulse_metrics_acceptance_executor'),
    ('005','public.sync_workos_verified_email(text,text)','pulse_metrics_email_sync_executor'),
    ('006','public.consume_invitation_rate_limit(text,text,text)','pulse_metrics_rate_limit_executor')
  ) AS expected(version,signature,owner)
  WHERE version=v_version;
  IF v_signature IS NULL THEN
    RAISE EXCEPTION 'Unexpected privileged migration version';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid=to_regprocedure(v_signature)
      AND p.prosecdef AND p.proowner=v_owner::regrole
      AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,ARRAY[]::text[])) setting
                  WHERE regexp_replace(setting,'[[:space:]]','','g')='search_path=pg_catalog,pg_temp')
  ) THEN
    RAISE EXCEPTION 'Function postcondition not met for step %', v_version;
  END IF;
  IF v_version IN ('003','006') AND NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE
      c.oid=CASE WHEN v_version='003' THEN to_regclass('public.organization_invitations')
                 ELSE to_regclass('public.invitation_rate_limits') END
      AND c.relowner='pulse_metrics_migrator'::regrole
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Protected table postcondition not met for step %',v_version;
  END IF;
END;
$guard$;
INSERT INTO pulse_security_migrations.applied_privileged_steps
  (version,script_path,source_sha256,recorded_mode)
VALUES (:'version', :'source_path', :'digest', 'fresh_replay');
COMMIT;
