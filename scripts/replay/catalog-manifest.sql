-- Read-only, stable structural inventory. No customer rows or secrets.
-- Output used to detect schema/permission drift between baseline and replay.
-- PostgreSQL catalog fields c.relkind and p.polcmd are internal "char" types.
-- Explicitly cast them to text before concatenation to avoid ambiguous || overloads.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
WITH items AS (
  SELECT 'table|' || n.nspname || '.' || c.relname || '|' ||
         pg_get_userbyid(c.relowner) || '|' || c.relkind::text || '|' ||
         c.relrowsecurity || '|' || c.relforcerowsecurity AS line
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','S')
  UNION ALL
  SELECT 'column|' || n.nspname || '.' || c.relname || '|' ||
         a.attnum || '|' || a.attname || '|' || format_type(a.atttypid,a.atttypmod) || '|' ||
         a.attnotnull || '|' || coalesce(pg_get_expr(ad.adbin,ad.adrelid),'')
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
  WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint|' || con.conname || '|' || c.relname || '|' || pg_get_constraintdef(con.oid)
  FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'index|' || c.relname || '|' || pg_get_indexdef(i.indexrelid)
  FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'policy|' || c.relname || '|' || p.polname || '|' || p.polcmd::text || '|' ||
    p.polpermissive || '|' || coalesce(pg_get_expr(p.polqual,p.polrelid),'') || '|' ||
    coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'function|' || p.oid::regprocedure::text || '|' ||
         pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|' ||
         md5(pg_get_functiondef(p.oid)) || '|' ||
         coalesce(array_to_string(p.proconfig,','),'')
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
  UNION ALL
  SELECT 'role|' || rolname || '|' || rolcanlogin || '|' || rolinherit || '|' ||
         rolsuper || '|' || rolbypassrls || '|' || rolcreatedb || '|' || rolcreaterole
  FROM pg_roles WHERE left(rolname,14) = 'pulse_metrics_'
  UNION ALL
  SELECT 'grant|' || c.relname || '|' || privilege || '|' ||
     has_table_privilege('pulse_metrics_app',c.oid,privilege)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) v(privilege)
  WHERE n.nspname='public' AND c.relkind='r'
  UNION ALL
  SELECT 'function-grant|' || p.oid::regprocedure::text || '|' ||
         has_function_privilege('pulse_metrics_app',p.oid,'EXECUTE')
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
)
SELECT line FROM items ORDER BY line;
COMMIT;
