-- Phase 2E3C5C1: strict audit of the privileged replay ledger.
-- Never run this as an adoption operation on the existing installation.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $verify$
BEGIN
  IF current_database()<>'pulse_metrics' OR current_user<>'postgres' THEN
    RAISE EXCEPTION 'Isolated replay administrator required';
  END IF;
  IF to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL THEN
    RAISE EXCEPTION 'Privileged replay ledger missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c
     WHERE c.oid='pulse_security_migrations.applied_privileged_steps'::regclass
       AND c.relowner='pulse_metrics_migrator'::regrole
       AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'Ledger must be migrator-owned with FORCE RLS';
  END IF;
  IF has_schema_privilege('pulse_metrics_app','pulse_security_migrations','USAGE')
     OR has_table_privilege('pulse_metrics_app',
       'pulse_security_migrations.applied_privileged_steps','SELECT')
     OR EXISTS (SELECT 1 FROM pg_policy WHERE
        polrelid='pulse_security_migrations.applied_privileged_steps'::regclass) THEN
    RAISE EXCEPTION 'Unacceptable runtime or RLS access to privileged ledger';
  END IF;
  IF (SELECT count(*) FROM public.__drizzle_migrations)<>1 THEN
    RAISE EXCEPTION 'Privileged replay must not forge Drizzle history';
  END IF;
  IF (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6 THEN
    RAISE EXCEPTION 'Six privileged receipts required';
  END IF;
  IF EXISTS (
    WITH expected(version,source_path,source_sha256) AS (VALUES
    ('001','scripts/admin/001_workos_identity_provisioning.sql','14f261b4bf7802a92e4c15d7f67cb563ad755fdf2bc4bcc1b7e39b8ad1d8aab7'),
    ('002','scripts/admin/002_organization_onboarding.sql','89a0251114f1839fb8449c41f62cb8c4f2d197a34155595746b66bd183c785dc'),
    ('003','scripts/admin/003_organization_invitations.sql','c07bb1a17375eb8b9522092b1d23a5f6aa4a21571c6e590aa34b3f0b27410e42'),
    ('004','scripts/admin/004_organization_invitation_acceptance.sql','d34fe9b8de7cec1e9109caefa7f33879f55188f00f051c8e2efb81d3bc4d4c9f'),
    ('005','scripts/admin/005_workos_verified_email_sync.sql','0bf20d0d11ad87505e7a0f58b61b85c6bb26413baef925c34da1b209c4476121'),
    ('006','scripts/admin/006_invitation_rate_limits.sql','597be8dfd60cff05947a1511f5ff6853bed6601b5e62bf9164f24f4943b33327')
    )
    SELECT 1 FROM expected e FULL JOIN pulse_security_migrations.applied_privileged_steps a
      ON a.version=e.version
    WHERE e.version IS NULL OR a.version IS NULL OR
      a.script_path<>e.source_path OR a.source_sha256<>e.source_sha256
      OR a.recorded_mode<>'fresh_replay'
  ) THEN
    RAISE EXCEPTION 'Privileged migration checksum, source or provenance mismatch';
  END IF;
  RAISE NOTICE 'PASS: six immutable fresh-replay receipts, no runtime read access and Drizzle history unchanged';
END;
$verify$;
COMMIT;
