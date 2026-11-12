-- Phase 2E3C5C2B: DISPOSABLE CLUSTER ONLY.
-- This DOES NOT add historical fresh-replay receipts and DOES NOT touch Drizzle.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR to_regclass('public.__drizzle_migrations') IS NULL
     OR (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 0
     OR to_regclass('pulse_security_migrations.verified_existing_baselines') IS NOT NULL THEN
    RAISE EXCEPTION 'REFUSE_ADOPTION_BOOTSTRAP: expected isolated legacy-state database with empty receipt ledger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='pulse_security_migrations.applied_privileged_steps'::regclass
     AND relowner='pulse_metrics_migrator'::regrole AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'REFUSE_ADOPTION_BOOTSTRAP: privilege ledger integrity failure';
  END IF;
END;
$guard$;
SET LOCAL ROLE pulse_metrics_migrator;
CREATE TABLE pulse_security_migrations.verified_existing_baselines (
  id smallint PRIMARY KEY DEFAULT 1,
  source_manifest_sha256 varchar(64) NOT NULL,
  catalog_sha256 varchar(64) NOT NULL,
  provenance varchar(32) NOT NULL DEFAULT 'verified_existing',
  evidence_scope varchar(64) NOT NULL DEFAULT 'reviewed_catalog_and_sql_sources',
  observed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  reviewed_step_count smallint NOT NULL DEFAULT 6,
  CONSTRAINT pulse_adoption_one_attestation CHECK (id = 1),
  CONSTRAINT pulse_adoption_manifest_hash CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT pulse_adoption_catalog_hash CHECK (catalog_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT pulse_adoption_provenance CHECK (provenance = 'verified_existing'),
  CONSTRAINT pulse_adoption_scope CHECK (evidence_scope = 'reviewed_catalog_and_sql_sources'),
  CONSTRAINT pulse_adoption_step_count CHECK (reviewed_step_count = 6)
);
ALTER TABLE pulse_security_migrations.verified_existing_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_security_migrations.verified_existing_baselines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE pulse_security_migrations.verified_existing_baselines
  FROM PUBLIC, pulse_metrics_app;
RESET ROLE;
COMMIT;
