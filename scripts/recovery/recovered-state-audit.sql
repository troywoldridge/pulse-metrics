-- Phase 2E3C5D1: post-restore verification, isolated cluster only.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $check$
DECLARE
 v_role text;
BEGIN
 IF current_database()<>'pulse_metrics' OR current_user<>'postgres' THEN
   RAISE EXCEPTION 'Restore audit requires isolated postgres/pulse_metrics';
 END IF;
 IF (SELECT count(*) FROM public.__drizzle_migrations)<>1 OR
    (SELECT hash FROM public.__drizzle_migrations LIMIT 1)<>
      'd49e23396a343852627ceab778521adaefc6382c2be6111bf83bf3e59ad870e1' THEN
   RAISE EXCEPTION 'Original Drizzle history did not survive';
 END IF;
 IF (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6 OR
    EXISTS (SELECT 1 FROM pulse_security_migrations.applied_privileged_steps
            WHERE recorded_mode<>'fresh_replay') THEN
   RAISE EXCEPTION 'Original security receipts did not survive';
 END IF;
 IF (SELECT count(*) FROM public.users WHERE auth_subject='user_recovery_rehearsal')<>1
    OR (SELECT count(*) FROM public.organizations WHERE slug='pulse-recovery-rehearsal')<>1
    OR (SELECT count(*) FROM public.organization_memberships)<>1
    OR (SELECT count(*) FROM public.monitored_agents WHERE hostname='backup-probe.invalid')<>1
    OR (SELECT count(*) FROM public.telemetry_samples WHERE metrics->>'origin'='synthetic-recovery-test')<>1
    OR (SELECT count(*) FROM public.organization_invitations WHERE token_hash=repeat('b',64))<>1
    OR (SELECT count(*) FROM public.invitation_rate_limits WHERE bucket_digest=repeat('a',64))<>1
    OR (SELECT count(*) FROM public.audit_events)<>2 THEN
   RAISE EXCEPTION 'Synthetic data missing after restore';
 END IF;
 IF to_regclass('pulse_security_migrations.verified_existing_baselines') IS NOT NULL THEN
   RAISE EXCEPTION 'Unexpected existing-adoption attestation after fresh replay';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE
       oid='pulse_security_migrations.applied_privileged_steps'::regclass
       AND relrowsecurity AND relforcerowsecurity
       AND relowner='pulse_metrics_migrator'::regrole)
    OR has_schema_privilege('pulse_metrics_app','pulse_security_migrations','USAGE')
    OR has_table_privilege('pulse_metrics_app',
       'pulse_security_migrations.applied_privileged_steps','SELECT') THEN
   RAISE EXCEPTION 'Private migration history leaked or lost protection';
 END IF;
 FOR v_role IN SELECT unnest(ARRAY[
    'pulse_metrics_identity_executor','pulse_metrics_onboarding_executor',
    'pulse_metrics_invitation_executor','pulse_metrics_acceptance_executor',
    'pulse_metrics_email_sync_executor','pulse_metrics_rate_limit_executor'
 ]) LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=v_role
       AND NOT rolcanlogin AND rolbypassrls AND NOT rolsuper AND NOT rolinherit) THEN
     RAISE EXCEPTION 'Missing expected restricted executor role %',v_role;
   END IF;
 END LOOP;
 RAISE NOTICE 'PASS: telemetry, synthetic records, Drizzle row, six receipts, private ledger and executor roles survived restore';
END;
$check$;
COMMIT;
