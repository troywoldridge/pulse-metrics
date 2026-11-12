-- Phase 2E3C5C2B: DISPOSABLE CLUSTER ONLY.
-- This records observed CURRENT STRUCTURE. It is not proof of when, how or
-- from which files the legacy six administrator operations were performed.
-- Variables must be supplied by guarded isolated-cluster harness only.
\set ON_ERROR_STOP on
\if :{?manifest_sha256}
\else
  \echo 'ERROR: expected independently verified manifest digest'
  \quit 1
\endif
\if :{?catalog_sha256}
\else
  \echo 'ERROR: expected independently verified catalog digest'
  \quit 1
\endif
BEGIN;
DO $guard$
DECLARE
  v_signature text;
  v_owner text;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR to_regclass('pulse_security_migrations.verified_existing_baselines') IS NULL
     OR (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 0
     OR EXISTS (SELECT 1 FROM pulse_security_migrations.verified_existing_baselines) THEN
    RAISE EXCEPTION 'REFUSE_ADOPTION_WRITE: ledger state or identity unexpected';
  END IF;
  IF has_schema_privilege('pulse_metrics_app', 'pulse_security_migrations', 'USAGE')
     OR has_table_privilege('pulse_metrics_app',
           'pulse_security_migrations.verified_existing_baselines', 'SELECT')
     OR has_table_privilege('pulse_metrics_app',
           'pulse_security_migrations.applied_privileged_steps', 'SELECT') THEN
    RAISE EXCEPTION 'REFUSE_ADOPTION_WRITE: API role can access private metadata';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class
      WHERE oid='pulse_security_migrations.verified_existing_baselines'::regclass
        AND relowner='pulse_metrics_migrator'::regrole
        AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'REFUSE_ADOPTION_WRITE: attestation table is not protected';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy
      WHERE polrelid='pulse_security_migrations.verified_existing_baselines'::regclass) THEN
    RAISE EXCEPTION 'REFUSE_ADOPTION_WRITE: attestation table must be policy free';
  END IF;
  -- More extensive catalog identity, grants, SQL source bytes and Drizzle
  -- ledger are verified by the wrapper before this transaction is opened.
  FOR v_signature, v_owner IN SELECT * FROM (VALUES
    ('public.resolve_workos_user(text)','pulse_metrics_identity_executor'),
    ('public.create_workos_organization(text,text,text)','pulse_metrics_onboarding_executor'),
    ('public.issue_organization_invitation(text,uuid,text,text,text,timestamptz)','pulse_metrics_invitation_executor'),
    ('public.accept_organization_invitation(text,text)','pulse_metrics_acceptance_executor'),
    ('public.sync_workos_verified_email(text,text)','pulse_metrics_email_sync_executor'),
    ('public.consume_invitation_rate_limit(text,text,text)','pulse_metrics_rate_limit_executor')
  ) AS expected(signature, owner) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure(v_signature)
        AND p.proowner=v_owner::regrole AND p.prosecdef
        AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) x
          WHERE regexp_replace(x,'[[:space:]]','','g')='search_path=pg_catalog,pg_temp')) THEN
      RAISE EXCEPTION 'REFUSE_ADOPTION_WRITE: privileged function missing or changed: %',v_signature;
    END IF;
  END LOOP;
END;
$guard$;
INSERT INTO pulse_security_migrations.verified_existing_baselines
  (source_manifest_sha256, catalog_sha256)
VALUES (:'manifest_sha256', :'catalog_sha256');
COMMIT;
