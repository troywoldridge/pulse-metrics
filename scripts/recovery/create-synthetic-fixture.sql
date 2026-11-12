-- Phase 2E3C5D1. Synthetic fixtures ONLY in the previously verified
-- isolated PostgreSQL cluster. Never apply to a real installation.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
 IF current_database()<>'pulse_metrics' OR current_user<>'postgres'
    OR to_regprocedure('public.resolve_workos_user(text)') IS NULL
    OR to_regprocedure('public.create_workos_organization(text,text,text)') IS NULL
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6 THEN
   RAISE EXCEPTION 'REFUSE_FIXTURE: expected isolated fresh migration replay';
 END IF;
 IF EXISTS (SELECT 1 FROM public.users WHERE auth_subject='user_recovery_rehearsal')
    OR EXISTS (SELECT 1 FROM public.organizations WHERE slug='pulse-recovery-rehearsal') THEN
   RAISE EXCEPTION 'REFUSE_FIXTURE: synthetic identities already exist';
 END IF;
END;
$guard$;
SELECT public.resolve_workos_user('user_recovery_rehearsal');
SELECT * FROM public.create_workos_organization(
  'user_recovery_rehearsal', 'Synthetic Recovery Rehearsal', 'pulse-recovery-rehearsal'
);
INSERT INTO public.monitored_agents
 (organization_id, display_name, hostname, platform, architecture)
SELECT id, 'Synthetic Backup Agent', 'backup-probe.invalid', 'linux', 'x86_64'
FROM public.organizations WHERE slug='pulse-recovery-rehearsal';
INSERT INTO public.telemetry_samples
 (organization_id, agent_id, recorded_at, cpu_usage_percent,
  memory_usage_percent, metrics)
SELECT organization_id, id, statement_timestamp(), 27.5, 42.0,
       '{"origin":"synthetic-recovery-test","measured":true}'::jsonb
FROM public.monitored_agents WHERE hostname='backup-probe.invalid';
SELECT public.issue_organization_invitation(
  'user_recovery_rehearsal',
  (SELECT id FROM public.organizations WHERE slug='pulse-recovery-rehearsal'),
  'recovery@example.invalid', 'viewer', repeat('b',64),
  statement_timestamp()+interval '1 day'
);
SELECT * FROM public.consume_invitation_rate_limit('issue','actor',repeat('a',64));
DO $verify$
BEGIN
 IF (SELECT count(*) FROM public.users WHERE auth_subject='user_recovery_rehearsal')<>1
    OR (SELECT count(*) FROM public.organizations WHERE slug='pulse-recovery-rehearsal')<>1
    OR (SELECT count(*) FROM public.organization_memberships)<>1
    OR (SELECT count(*) FROM public.monitored_agents WHERE hostname='backup-probe.invalid')<>1
    OR (SELECT count(*) FROM public.telemetry_samples WHERE metrics->>'origin'='synthetic-recovery-test')<>1
    OR (SELECT count(*) FROM public.organization_invitations WHERE token_hash=repeat('b',64))<>1
    OR (SELECT count(*) FROM public.invitation_rate_limits WHERE bucket_digest=repeat('a',64))<>1
    OR (SELECT count(*) FROM public.audit_events)<>2 THEN
   RAISE EXCEPTION 'Synthetic fixture creation failed';
 END IF;
END;
$verify$;
COMMIT;
