-- Phase 2E3C5D2. Read-only inventory of security-relevant cluster roles,
-- membership and pulse_metrics database-level privileges/settings.
-- Ignores the separate replacement-cluster-only bootstrap superuser.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
WITH inventory AS (
  SELECT 'role|' || rolname || '|' || rolsuper || '|' || rolinherit || '|' ||
         rolcreaterole || '|' || rolcreatedb || '|' || rolcanlogin || '|' ||
         rolreplication || '|' || rolbypassrls || '|' || rolconnlimit || '|' ||
         coalesce(array_to_string(rolconfig, ','), '') AS entry
  FROM pg_roles
  WHERE rolname='postgres' OR left(rolname, 14)='pulse_metrics_'
  UNION ALL
  SELECT 'membership|' || member.rolname || '|' || parent.rolname || '|' ||
         m.admin_option || '|' || m.inherit_option || '|' || m.set_option
  FROM pg_auth_members m
  JOIN pg_roles parent ON parent.oid=m.roleid
  JOIN pg_roles member ON member.oid=m.member
  WHERE (member.rolname='postgres' OR left(member.rolname,14)='pulse_metrics_')
    AND (parent.rolname='postgres' OR left(parent.rolname,14)='pulse_metrics_')
  UNION ALL
  SELECT 'db|' || d.datname || '|' || pg_get_userbyid(d.datdba) || '|' ||
         d.datallowconn || '|' || d.datconnlimit || '|' || d.datistemplate
  FROM pg_database d WHERE d.datname='pulse_metrics'
  UNION ALL
  SELECT 'db-grant|' || CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END ||
         '|' || acl.privilege_type || '|' || acl.is_grantable || '|' ||
         pg_get_userbyid(acl.grantor)
  FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) acl
  WHERE d.datname='pulse_metrics'
  UNION ALL
  SELECT 'db-role-setting|' || r.rolname || '|' || d.datname || '|' ||
         array_to_string(s.setconfig, ',')
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid=s.setrole
  JOIN pg_database d ON d.oid=s.setdatabase
  WHERE d.datname='pulse_metrics'
    AND (r.rolname='postgres' OR left(r.rolname,14)='pulse_metrics_')
)
SELECT entry FROM inventory ORDER BY entry;
COMMIT;
