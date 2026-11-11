-- Pulse Metrics — Phase 2E3C5A: READ-ONLY local migration baseline audit.
-- Called by the guarded shell wrapper. NEVER apply schema changes here.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;

\echo '========== DATABASE AND MIGRATION LEDGER =========='
SELECT current_database() AS database, current_user AS audit_role,
       current_setting('server_version') AS postgresql_version;
SELECT id, left(hash, 12) AS migration_hash_prefix, created_at
FROM public.__drizzle_migrations ORDER BY id;

\echo '========== TABLE OWNERSHIP AND RLS =========='
SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
  AND c.relname IN (
    'organizations','users','organization_memberships','monitored_agents',
    'agent_enrollment_tokens','agent_credentials','telemetry_samples',
    'audit_events','organization_invitations','invitation_rate_limits'
  ) ORDER BY c.relname;

\echo '========== SECURITY FUNCTIONS =========='
SELECT p.oid::regprocedure AS function_signature,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       array_to_string(p.proconfig,', ') AS function_settings
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN (
    'resolve_workos_user','create_workos_organization',
    'issue_organization_invitation','accept_organization_invitation',
    'sync_workos_verified_email','consume_invitation_rate_limit'
  ) ORDER BY p.proname;

\echo '========== AUTOMATED SECURITY ASSERTIONS =========='
DO $audit$
DECLARE
  v_name text;
  v_signature text;
  v_oid oid;
  v_role text;
  v_permissions text;
  v_bad_count integer;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Audit restricted to pulse_metrics as local postgres';
  END IF;
  IF to_regclass('public.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'Drizzle migration ledger missing';
  END IF;
  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one recorded foundational Drizzle migration; investigate before replay';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='pulse_metrics_app' AND rolcanlogin
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication
  ) THEN
    RAISE EXCEPTION 'Runtime role has unsafe attributes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='pulse_metrics_migrator'
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication
  ) THEN
    RAISE EXCEPTION 'Migrator role has unsafe attributes';
  END IF;

  FOREACH v_name IN ARRAY ARRAY[
    'organizations','users','organization_memberships','monitored_agents',
    'agent_enrollment_tokens','agent_credentials','telemetry_samples',
    'audit_events','organization_invitations','invitation_rate_limits'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_name AND c.relkind='r'
        AND c.relrowsecurity AND c.relforcerowsecurity
        AND c.relowner='pulse_metrics_migrator'::regrole
    ) THEN
      RAISE EXCEPTION 'Required table % missing, wrong owner or missing FORCE RLS', v_name;
    END IF;
  END LOOP;

  -- Sensitive tables MUST remain policy-free and inaccessible to ordinary runtime.
  SELECT count(*) INTO v_bad_count
  FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (
    'agent_credentials','agent_enrollment_tokens',
    'organization_invitations','invitation_rate_limits'
  );
  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION 'Protected credential/invitation/counter tables unexpectedly have RLS policies';
  END IF;
  FOREACH v_name IN ARRAY ARRAY[
    'agent_credentials','agent_enrollment_tokens',
    'organization_invitations','invitation_rate_limits'
  ] LOOP
    FOREACH v_permissions IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
      IF has_table_privilege('pulse_metrics_app','public.' || v_name,v_permissions) THEN
        RAISE EXCEPTION 'Runtime role has direct % permission on %',v_permissions,v_name;
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('pulse_metrics_app','public.organization_memberships','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','UPDATE')
     OR has_table_privilege('pulse_metrics_app','public.organization_memberships','DELETE')
     OR has_table_privilege('pulse_metrics_app','public.users','UPDATE')
     OR has_column_privilege('pulse_metrics_app','public.users','email','UPDATE')
     OR has_column_privilege('pulse_metrics_app','public.users','email_verified_at','UPDATE') THEN
    RAISE EXCEPTION 'Runtime has unsafe direct identity/membership writes';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'pulse_metrics_invitation_executor',
    'pulse_metrics_acceptance_executor',
    'pulse_metrics_email_sync_executor',
    'pulse_metrics_rate_limit_executor'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname=v_role
        AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication
        AND rolbypassrls AND NOT rolinherit
    ) THEN
      RAISE EXCEPTION 'Privileged function owner % has unsafe attributes',v_role;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members
      WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname=v_role)
         OR member=(SELECT oid FROM pg_roles WHERE rolname=v_role)
    ) THEN
      RAISE EXCEPTION 'Privileged function owner % has role memberships',v_role;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.resolve_workos_user(text)',
    'public.create_workos_organization(text,text,text)',
    'public.issue_organization_invitation(text,uuid,text,text,text,timestamp with time zone)',
    'public.accept_organization_invitation(text,text)',
    'public.sync_workos_verified_email(text,text)',
    'public.consume_invitation_rate_limit(text,text,text)'
  ] LOOP
    v_oid:=to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'Required function missing: %',v_signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=v_oid AND p.prosecdef
        AND p.proowner <> 'pulse_metrics_app'::regrole
        AND p.proowner <> 'postgres'::regrole
        AND EXISTS (
          SELECT 1 FROM unnest(coalesce(p.proconfig,ARRAY[]::text[])) setting
          WHERE regexp_replace(setting,'[[:space:]]','','g') =
                'search_path=pg_catalog,pg_temp'
        )
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
        )
    ) THEN
      RAISE EXCEPTION 'Function ownership, search_path or PUBLIC EXECUTE unsafe: %',v_signature;
    END IF;
    IF NOT has_function_privilege('pulse_metrics_app',v_oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Runtime cannot execute expected narrow function: %',v_signature;
    END IF;
  END LOOP;

  RAISE NOTICE 'PASS: read-only identity, migration, RLS, role and function invariants';
END;
$audit$;
COMMIT;
