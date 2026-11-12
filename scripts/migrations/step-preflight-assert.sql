-- Phase 2E3C5C2A. Include only in a verified isolated-cluster psql session.
-- Requires an existing transaction and transaction-local pulse.replay_step_version.
-- A missing receipt is NEVER evidence that the associated SQL can be rerun.
\set ON_ERROR_STOP on
DO $preflight$
DECLARE
  v_version text := current_setting('pulse.replay_step_version', true);
  v_number integer;
  v_signature text;
  v_owner text;
  v_table text;
  v_previous integer;
BEGIN
  IF current_database()<>'pulse_metrics' OR current_user<>'postgres' OR
     to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL OR
     (SELECT count(*) FROM public.__drizzle_migrations)<>1 OR
     v_version IS NULL OR v_version !~ '^00[1-6]$' THEN
    RAISE EXCEPTION 'INVALID_REPLAY_PREFLIGHT_CONTEXT';
  END IF;
  SELECT signature, role_name, table_name
  INTO v_signature, v_owner, v_table
  FROM (VALUES
    ('001','public.resolve_workos_user(text)','pulse_metrics_identity_executor',NULL::text),
    ('002','public.create_workos_organization(text,text,text)','pulse_metrics_onboarding_executor',NULL::text),
    ('003','public.issue_organization_invitation(text,uuid,text,text,text,timestamptz)','pulse_metrics_invitation_executor','public.organization_invitations'),
    ('004','public.accept_organization_invitation(text,text)','pulse_metrics_acceptance_executor',NULL::text),
    ('005','public.sync_workos_verified_email(text,text)','pulse_metrics_email_sync_executor',NULL::text),
    ('006','public.consume_invitation_rate_limit(text,text,text)','pulse_metrics_rate_limit_executor','public.invitation_rate_limits')
  ) AS expected(version,signature,role_name,table_name) WHERE version=v_version;
  IF v_signature IS NULL THEN RAISE EXCEPTION 'UNKNOWN_REPLAY_STEP'; END IF;
  IF EXISTS (SELECT 1 FROM pulse_security_migrations.applied_privileged_steps
             WHERE version=v_version) THEN
    RAISE EXCEPTION 'RECEIPT_ALREADY_PRESENT: step % must be skipped', v_version;
  END IF;
  v_number:=v_version::integer;
  FOR v_previous IN 1..v_number-1 LOOP
    IF NOT EXISTS (SELECT 1 FROM pulse_security_migrations.applied_privileged_steps
       WHERE version=lpad(v_previous::text,3,'0')) THEN
      RAISE EXCEPTION 'MISSING_PRIOR_RECEIPT: step %',lpad(v_previous::text,3,'0');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pulse_security_migrations.applied_privileged_steps
             WHERE version>v_version) THEN
    RAISE EXCEPTION 'OUT_OF_ORDER_REPLAY_STEP: %',v_version;
  END IF;
  IF to_regprocedure(v_signature) IS NOT NULL
     OR to_regrole(v_owner) IS NOT NULL
     OR (v_table IS NOT NULL AND to_regclass(v_table) IS NOT NULL) THEN
    RAISE EXCEPTION 'UNRECORDED_EXISTING_OBJECT: step % requires manual reconciliation, not replay',v_version;
  END IF;
END;
$preflight$;
