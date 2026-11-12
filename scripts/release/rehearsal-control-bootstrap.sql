-- Phase 2E3C5D3. Test-only control objects, in an ISOLATED cluster ONLY.
-- Called with an explicit verified disposable Unix socket by rehearsal shell.
-- Not a deployable production migration/approval schema.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
 IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
    OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
    OR to_regnamespace('pulse_release_rehearsal') IS NOT NULL THEN
  RAISE EXCEPTION 'REFUSE_RELEASE_BOOTSTRAP: incorrect disposable fresh-replay baseline';
 END IF;
END;
$guard$;
CREATE SCHEMA pulse_release_rehearsal AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA pulse_release_rehearsal FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA pulse_release_rehearsal TO pulse_metrics_migrator;

CREATE TABLE pulse_release_rehearsal.release_receipts (
 release_id text PRIMARY KEY,
 plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
 migration_sha256 text NOT NULL CHECK (migration_sha256 ~ '^[0-9a-f]{64}$'),
 operator_subject text NOT NULL,
 operator_key_id text NOT NULL,
 reviewer_subject text NOT NULL,
 reviewer_key_id text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pulse_release_rehearsal.release_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pulse_release_rehearsal.release_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pulse_release_rehearsal.release_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON pulse_release_rehearsal.release_receipts TO pulse_metrics_migrator;
CREATE POLICY synthetic_migrator_receipt_read ON pulse_release_rehearsal.release_receipts
 FOR SELECT TO pulse_metrics_migrator USING (true);
CREATE POLICY synthetic_migrator_receipt_insert ON pulse_release_rehearsal.release_receipts
 FOR INSERT TO pulse_metrics_migrator WITH CHECK (true);
-- No UPDATE or DELETE grants/policies. Runtime role cannot even use schema.

-- Fixed-logic read-only attestation (test harness only): the migrator cannot
-- directly read the private privileged receipt ledger due to FORCE RLS.
CREATE FUNCTION pulse_release_rehearsal.reviewed_baseline_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $fn$
SELECT current_database()='pulse_metrics'
 AND (SELECT count(*) FROM public.__drizzle_migrations)=1
 AND (SELECT hash FROM public.__drizzle_migrations LIMIT 1)=
   'd49e23396a343852627ceab778521adaefc6382c2be6111bf83bf3e59ad870e1'
 AND (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)=6
 AND NOT EXISTS (
   WITH expected(version, script_path, source_sha256) AS (VALUES
     ('001','scripts/admin/001_workos_identity_provisioning.sql','14f261b4bf7802a92e4c15d7f67cb563ad755fdf2bc4bcc1b7e39b8ad1d8aab7'),
     ('002','scripts/admin/002_organization_onboarding.sql','89a0251114f1839fb8449c41f62cb8c4f2d197a34155595746b66bd183c785dc'),
     ('003','scripts/admin/003_organization_invitations.sql','c07bb1a17375eb8b9522092b1d23a5f6aa4a21571c6e590aa34b3f0b27410e42'),
     ('004','scripts/admin/004_organization_invitation_acceptance.sql','d34fe9b8de7cec1e9109caefa7f33879f55188f00f051c8e2efb81d3bc4d4c9f'),
     ('005','scripts/admin/005_workos_verified_email_sync.sql','0bf20d0d11ad87505e7a0f58b61b85c6bb26413baef925c34da1b209c4476121'),
     ('006','scripts/admin/006_invitation_rate_limits.sql','597be8dfd60cff05947a1511f5ff6853bed6601b5e62bf9164f24f4943b33327')
   )
   SELECT 1 FROM expected e
     FULL JOIN pulse_security_migrations.applied_privileged_steps a
     ON a.version=e.version
   WHERE e.version IS NULL OR a.version IS NULL
      OR a.script_path<>e.script_path
      OR a.source_sha256<>e.source_sha256
      OR a.recorded_mode<>'fresh_replay'
 )
$fn$;
REVOKE ALL ON FUNCTION pulse_release_rehearsal.reviewed_baseline_ok() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pulse_release_rehearsal.reviewed_baseline_ok() TO pulse_metrics_migrator;
COMMIT;
