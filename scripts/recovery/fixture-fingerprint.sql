-- Phase 2E3C5D1: read-only content fingerprint, synthetic cluster only.
-- A deterministic hash of *every row* in eight app tables, sequence state,
-- and both ledgers. Never run on actual customer data.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT encode(sha256(convert_to(jsonb_build_object(
 'users',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.users t),
 'organizations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.organizations t),
 'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY organization_id,user_id),'[]'::jsonb) FROM public.organization_memberships t),
 'agents',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.monitored_agents t),
 'telemetry',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.telemetry_samples t),
 'telemetry_sequence',(SELECT jsonb_build_object('last_value',last_value,'is_called',is_called)
                       FROM public.telemetry_samples_id_seq),
 'audit',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.audit_events t),
 'invitations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.organization_invitations t),
 'rate_limits',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY action,bucket_kind,bucket_digest),'[]'::jsonb) FROM public.invitation_rate_limits t),
 'drizzle',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.__drizzle_migrations t),
 'privileged_receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb) FROM pulse_security_migrations.applied_privileged_steps t)
)::text,'UTF8')),'hex') AS synthetic_fixture_sha256;
COMMIT;
