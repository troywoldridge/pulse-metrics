-- Phase 2E3C5C1 — ISOLATED REPLAY CLUSTER ONLY.
-- This script is never applied to the existing working installation.
-- The separate privileged ledger does not forge a Drizzle migration entry.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR to_regclass('public.__drizzle_migrations') IS NULL
     OR (SELECT count(*) FROM public.__drizzle_migrations) <> 1 THEN
    RAISE EXCEPTION 'Expected freshly Drizzle-migrated isolated pulse_metrics database';
  END IF;
  IF to_regnamespace('pulse_security_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'Privileged replay ledger already exists; refusing replacement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_migrator')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_app') THEN
    RAISE EXCEPTION 'Expected replay-only PostgreSQL role foundation';
  END IF;
END;
$guard$;

SET LOCAL ROLE pulse_metrics_migrator;
CREATE SCHEMA pulse_security_migrations;
REVOKE ALL ON SCHEMA pulse_security_migrations FROM PUBLIC, pulse_metrics_app;
CREATE TABLE pulse_security_migrations.applied_privileged_steps (
  version varchar(3) PRIMARY KEY,
  script_path text NOT NULL UNIQUE,
  source_sha256 varchar(64) NOT NULL,
  recorded_mode varchar(20) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT pulse_privileged_step_version CHECK (version ~ '^00[1-6]$'),
  CONSTRAINT pulse_privileged_step_source CHECK
    (script_path ~ '^scripts/admin/00[1-6]_[a-z_]+[.]sql$'),
  CONSTRAINT pulse_privileged_step_digest CHECK
    (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT pulse_privileged_step_mode CHECK (recorded_mode='fresh_replay')
);
ALTER TABLE pulse_security_migrations.applied_privileged_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_security_migrations.applied_privileged_steps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE pulse_security_migrations.applied_privileged_steps
  FROM PUBLIC, pulse_metrics_app;
-- No RLS policies. No runtime or executor access. Only local administrator
-- writes a receipt after an original script exits successfully.
RESET ROLE;
COMMIT;
