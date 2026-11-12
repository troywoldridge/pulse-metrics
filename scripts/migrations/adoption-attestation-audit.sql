-- Phase 2E3C5C2B: inspect isolated attestation, never customer data.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $verify$
DECLARE
  v record;
BEGIN
  IF current_database()<>'pulse_metrics' OR current_user<>'postgres' THEN
    RAISE EXCEPTION 'Expected isolated postgres administrator';
  END IF;
  IF to_regclass('pulse_security_migrations.verified_existing_baselines') IS NULL
     OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>0
     OR (SELECT count(*) FROM public.__drizzle_migrations)<>1 THEN
    RAISE EXCEPTION 'Attestation must not be confused with migration execution receipts';
  END IF;
  IF (SELECT count(*) FROM pulse_security_migrations.verified_existing_baselines)<>1 THEN
    RAISE EXCEPTION 'Expected exactly one existing-state attestation';
  END IF;
  SELECT * INTO v FROM pulse_security_migrations.verified_existing_baselines;
  IF v.id<>1 OR v.provenance<>'verified_existing'
     OR v.evidence_scope<>'reviewed_catalog_and_sql_sources'
     OR v.reviewed_step_count<>6 THEN
    RAISE EXCEPTION 'Existing-state attestation provenance is invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy
    WHERE polrelid='pulse_security_migrations.verified_existing_baselines'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_class c
       WHERE c.oid='pulse_security_migrations.verified_existing_baselines'::regclass
         AND c.relowner='pulse_metrics_migrator'::regrole
         AND c.relrowsecurity AND c.relforcerowsecurity)
     OR has_schema_privilege('pulse_metrics_app','pulse_security_migrations','USAGE')
     OR has_table_privilege('pulse_metrics_app',
       'pulse_security_migrations.verified_existing_baselines','SELECT') THEN
    RAISE EXCEPTION 'Existing-state attestation security boundary violated';
  END IF;
  RAISE NOTICE 'PASS: one verified_existing attestation, zero fresh_replay receipts; original Drizzle history unchanged';
END;
$verify$;
COMMIT;
