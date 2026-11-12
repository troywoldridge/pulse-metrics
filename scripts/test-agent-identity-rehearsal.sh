#!/usr/bin/env bash
# Phase 2E3C5D10: isolated ingress quota / transport candidate rehearsal ONLY.
# All writes happen only in a marker-verified disposable Unix-only cluster.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT || true
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -f .env ]] || fail 'Reviewed local .env missing'
for tool in node sudo psql pg_config sha256sum mktemp git python3 cmp timeout env; do
  command -v "$tool" >/dev/null || fail "Missing prerequisite: $tool"
done
node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw || process.env.NODE_ENV === 'production') throw Error('Production/missing DB refused');
const u = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(u.username) !== 'pulse_metrics_app') {
  throw Error('Only reviewed local development runtime configuration allowed');
}
console.log('PASS: local development-only runtime identity');
NODE
node scripts/migrations/verify-manifest.mjs
node scripts/agent-enrollment/verify-candidate.mjs
# Only read-only commands in the original developer PostgreSQL cluster.
bash scripts/migrations/audit-adoption-drift.sh
BASELINE='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
MAIN_VERSION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics \
  -c "SELECT current_setting('server_version_num')")" || fail 'Local server version unavailable'
[[ "$MAIN_VERSION" =~ ^[0-9]{5,6}$ ]] || fail 'Invalid PostgreSQL version'
MAJOR="$((MAIN_VERSION / 10000))"
PG_BIN="$(pg_config --bindir)"
if [[ -x "/usr/lib/postgresql/$MAJOR/bin/initdb" ]]; then
  PG_BIN="/usr/lib/postgresql/$MAJOR/bin"
fi
for tool in initdb pg_ctl postgres psql createdb; do
  [[ -x "$PG_BIN/$tool" ]] || fail "Missing matched PostgreSQL binary $tool"
done
VERSION_TEXT="$("$PG_BIN/postgres" --version)"
if [[ "$VERSION_TEXT" =~ PostgreSQL\)?[[:space:]]+([0-9]+)([.]|$) ]]; then
  [[ "${BASH_REMATCH[1]}" == "$MAJOR" ]] || fail 'PostgreSQL major differs'
else
  fail 'Unexpected PostgreSQL version string'
fi
[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ && "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
  fail 'Unexpected OS user or group'
BASE=''; DATA=''; SOCKET=''; PORT=55432
cleanup() {
  local code=$? stopped=1
  trap - EXIT
  set +e
  if [[ -n "$BASE" && "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
     sudo -u postgres test -f "$BASE/.pulse-agent-enrollment-marker"; then
    echo '========== STOP DISPOSABLE AGENT ENROLLMENT CLUSTER =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null 2>&1 ||
        sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || stopped=0
    fi
    if [[ "$stopped" -eq 1 ]] &&
       ! sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres rm -rf -- "$BASE" || stopped=0
    else
      stopped=0
    fi
    if [[ "$stopped" -eq 0 ]]; then
      echo "CRITICAL: isolated PostgreSQL cluster retained at $BASE; inspect manually" >&2
      code=1
    else
      echo 'PASS: disposable agent enrollment cluster and test-only secrets removed'
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] || fail 'Invalid temporary cluster path'
DATA="$BASE/data"
SOCKET="$BASE/socket"
sudo -u postgres touch "$BASE/.pulse-agent-enrollment-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"
sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

echo '========== BOOTSTRAP ISOLATED AGENT ENROLLMENT CLUSTER =========='
sudo -u postgres "$PG_BIN/initdb" -D "$DATA" --username=postgres \
  --auth-local=peer --auth-host=reject --no-instructions >/dev/null
sudo -u postgres tee "$DATA/pg_ident.conf" >/dev/null <<IDENT
pulse_release $(id -un) pulse_metrics_migrator
pulse_release $(id -un) pulse_metrics_app
IDENT
sudo -u postgres tee "$DATA/pg_hba.conf" >/dev/null <<'HBA'
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_release
local pulse_metrics pulse_metrics_app peer map=pulse_release
local all all reject
host all all 0.0.0.0/0 reject
host all all ::/0 reject
HBA
sudo -u postgres tee -a "$DATA/postgresql.conf" >/dev/null <<CONFIG
listen_addresses = ''
port = $PORT
unix_socket_directories = '$SOCKET'
unix_socket_permissions = 0777
logging_collector = off
CONFIG
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/start.log" -w start >/dev/null
ID="$(sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At \
  -h "$SOCKET" -p "$PORT" -U postgres -d postgres -c \
  "SELECT current_setting('data_directory') || '|' || current_user || '|' || \
  (inet_server_addr() IS NULL)::text || '|' || (current_setting('listen_addresses')='')::text")"
[[ "$ID" == "$DATA|postgres|true|true" ]] || fail 'Isolated socket, role or data directory not verified'
echo 'PASS: independent marked data directory, peer Unix socket, TCP-disabled server verified'
psql_admin() {
  local db="$1"; shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$db" "$@"
}
psql_admin postgres -q < scripts/replay/bootstrap-roles.sql
sudo -u postgres "$PG_BIN/createdb" -h "$SOCKET" -p "$PORT" -U postgres -O postgres pulse_metrics
psql_admin pulse_metrics -q < scripts/replay/bootstrap-database.sql
PULSE_REPLAY_SOCKET="$SOCKET" PULSE_REPLAY_DATA="$DATA" PULSE_REPLAY_PORT="$PORT" \
  node scripts/replay/migrate-isolated.mjs
psql_admin pulse_metrics -q < scripts/replay/runtime-grants.sql
psql_admin pulse_metrics -q < scripts/migrations/ledger-bootstrap.sql
STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)" || fail 'Cannot validate reviewed SQL manifest'
[[ "$(printf '%s\n' "$STEPS" | wc -l)" -eq 6 ]] || fail 'Expected exactly six reviewed SQL sources'
while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ && "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ &&
    "$source" == scripts/admin/${version}_* && "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'Invalid privileged SQL manifest record'
  {
    printf 'BEGIN READ ONLY;\n'
    printf "SELECT set_config('pulse.replay_step_version','%s',true);\n" "$version"
    cat scripts/migrations/step-preflight-assert.sql
    printf 'COMMIT;\n'
  } | psql_admin pulse_metrics -q >/dev/null
  psql_admin pulse_metrics -q < "$source"
  psql_admin pulse_metrics -q -v "version=$version" -v "source_path=$source" \
    -v "digest=$digest" < scripts/migrations/ledger-record.sql
  echo "RECORDED reviewed privileged step $version in disposable cluster"
done <<< "$STEPS"
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
ORIGINAL_CATALOG="$(psql_admin pulse_metrics -Atq < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$ORIGINAL_CATALOG" == "$BASELINE" ]] || fail 'Pre-release public security fingerprint mismatch'

echo '========== APPLY PINNED MIGRATION CANDIDATE IN DISPOSABLE CLUSTER =========='
node scripts/agent-enrollment/verify-candidate.mjs
psql_admin pulse_metrics -q < scripts/agent-enrollment/migrations/0001_agent_enrollment.sql
psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;
DO $v$
BEGIN
 IF (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations WHERE version='0001') <> 1
    OR (SELECT count(*) FROM public.__drizzle_migrations) <> 1
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6 THEN
   RAISE EXCEPTION 'Version receipt or historical ledger changed';
 END IF;
END;
$v$;
COMMIT;
SQL

echo '========== APPLY D10 PINNED DISTRIBUTED QUOTA CANDIDATE =========='
node scripts/agent-ingress/verify-ingress-candidate.mjs
psql_admin pulse_metrics -q < scripts/agent-ingress/migrations/0002_agent_ingress_quota.sql
psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;
DO $assert$
DECLARE r record;
BEGIN
 SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
        rolbypassrls,rolinherit INTO r FROM pg_roles
 WHERE rolname='pulse_metrics_agent_ingress_executor';
 IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR
    r.rolcreaterole OR r.rolreplication OR NOT r.rolbypassrls OR r.rolinherit
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE
      roleid='pulse_metrics_agent_ingress_executor'::regrole OR
      member='pulse_metrics_agent_ingress_executor'::regrole)
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations)<>2
    OR (SELECT count(*) FROM public.__drizzle_migrations)<>1
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='pulse_agent_enrollment.ingress_rate_limits'::regclass
      AND relrowsecurity AND relforcerowsecurity AND relowner='postgres'::regrole)
    OR has_table_privilege('pulse_metrics_app','pulse_agent_enrollment.ingress_rate_limits','SELECT')
    OR has_table_privilege('pulse_metrics_app','pulse_agent_enrollment.ingress_rate_limits','INSERT')
    OR has_table_privilege('pulse_metrics_app','pulse_agent_enrollment.schema_migrations','SELECT')
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE
       oid=to_regprocedure('pulse_agent_enrollment.consume_ingress_quota(text,text,text)')
       AND prosecdef AND proowner='pulse_metrics_agent_ingress_executor'::regrole
       AND EXISTS (SELECT 1 FROM unnest(coalesce(proconfig,ARRAY[]::text[])) x
         WHERE regexp_replace(x,'[[:space:]]','','g')='search_path=pg_catalog,pg_temp'))
    OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
      aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.oid=to_regprocedure('pulse_agent_enrollment.consume_ingress_quota(text,text,text)')
        AND acl.grantee=0 AND acl.privilege_type='EXECUTE') THEN
   RAISE EXCEPTION 'D10 ingress quota role, receipt or protected SQL mismatch';
 END IF;
 RAISE NOTICE 'PASS: D10 fixed quotas, 2 receipts, restricted runtime and separate NOLOGIN executor';
END;
$assert$;
COMMIT;
SQL

echo '========== D10 REAL PERSISTED QUOTA + CONCURRENCY TEST =========='
timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES PULSE_AGENT_SOCKET="$SOCKET" PULSE_AGENT_DATA="$DATA" \
  node scripts/agent-ingress/quota-integration.mjs

echo '========== D10 LOOPBACK HTTP + PERSISTED QUOTA TEST =========='
timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES PULSE_AGENT_SOCKET="$SOCKET" PULSE_AGENT_DATA="$DATA" \
  node --import tsx scripts/agent-ingress/ingress-http-integration.ts

# Fixture owners/users/roles are synthetic; never derived from credentials or
# actual WorkOS profiles. This SQL only runs on the verified private socket.
echo '========== CREATE SYNTHETIC TWO-ORGANIZATION FIXTURE =========='
psql_admin pulse_metrics -q <<'SQL'
BEGIN;
SELECT public.resolve_workos_user('user_agent_owner_a');
SELECT public.resolve_workos_user('user_agent_owner_b');
SELECT public.resolve_workos_user('user_agent_viewer_a');
SELECT * FROM public.create_workos_organization('user_agent_owner_a',
  'Synthetic Agent Tenant A','pulse-agent-a');
SELECT * FROM public.create_workos_organization('user_agent_owner_b',
  'Synthetic Agent Tenant B','pulse-agent-b');
INSERT INTO public.organization_memberships (organization_id,user_id,role)
SELECT o.id,u.id,'viewer'::public.membership_role
FROM public.organizations o CROSS JOIN public.users u
WHERE o.slug='pulse-agent-a' AND u.auth_subject='user_agent_viewer_a';
-- Explicit negative-case fixtures; only hashed synthetic values, never raw secrets.
INSERT INTO public.agent_enrollment_tokens
 (organization_id,token_prefix,token_hash,label,created_by_user_id,max_uses,uses,expires_at,revoked_at)
SELECT o.id,left(v.digest,12),v.digest,'Synthetic negative fixture',u.id,1,0,v.expiry,v.revoked
FROM public.organizations o
JOIN public.users u ON u.auth_subject='user_agent_owner_a'
CROSS JOIN (VALUES
 (repeat('e',64),clock_timestamp()-interval '1 minute',NULL::timestamptz),
 (repeat('d',64),clock_timestamp()+interval '10 minutes',clock_timestamp())
) AS v(digest,expiry,revoked)
WHERE o.slug='pulse-agent-a';
DO $check$
BEGIN
 IF (SELECT count(*) FROM public.organizations WHERE slug IN ('pulse-agent-a','pulse-agent-b'))<>2
    OR (SELECT count(*) FROM public.organization_memberships)<>3
    OR (SELECT count(*) FROM public.users WHERE auth_subject LIKE 'user_agent_%')<>3 THEN
   RAISE EXCEPTION 'Synthetic two-organization identity fixture failed';
 END IF;
END;
$check$;
COMMIT;
SQL
ORG_A="$(psql_admin pulse_metrics -Atq -c "SELECT id FROM public.organizations WHERE slug='pulse-agent-a'")"
ORG_B="$(psql_admin pulse_metrics -Atq -c "SELECT id FROM public.organizations WHERE slug='pulse-agent-b'")"
[[ "$ORG_A" =~ ^[0-9a-f-]{36}$ && "$ORG_B" =~ ^[0-9a-f-]{36}$ && "$ORG_A" != "$ORG_B" ]] ||
  fail 'Invalid isolated organization UUID fixtures'

MIGRATOR_ID="$("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_app -d pulse_metrics -c \
  "SELECT current_user || '|' || current_database() || '|' || (inet_server_addr() IS NULL)::text")"
[[ "$MIGRATOR_ID" == 'pulse_metrics_app|pulse_metrics|true' ]] ||
  fail 'Unprivileged application role/Unix-socket identity failed'

echo '========== TEST ISSUE/REDEEM/REPLAY/RACE/ROTATION/REVOCATION =========='
timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES PULSE_AGENT_SOCKET="$SOCKET" PULSE_AGENT_DATA="$DATA" \
  PULSE_AGENT_ORG_A="$ORG_A" PULSE_AGENT_ORG_B="$ORG_B" \
  node scripts/agent-enrollment/migration-integration.mjs

echo '========== AUDIT LEAST-PRIVILEGE ISOLATED FIXTURE =========='
psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;
DO $check$
DECLARE r record;
BEGIN
 SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
        rolbypassrls, rolinherit INTO r
 FROM pg_roles WHERE rolname='pulse_metrics_agent_enrollment_executor';
 IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb
    OR r.rolcreaterole OR r.rolreplication OR NOT r.rolbypassrls OR r.rolinherit
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE
      roleid='pulse_metrics_agent_enrollment_executor'::regrole OR
      member='pulse_metrics_agent_enrollment_executor'::regrole) THEN
   RAISE EXCEPTION 'Synthetic agent executor unexpectedly privileged';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='pulse_agent_enrollment.schema_migrations'::regclass
   AND relrowsecurity AND relforcerowsecurity AND relowner='postgres'::regrole)
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations WHERE version='0001')<>1
    OR (SELECT count(*) FROM public.agent_enrollment_tokens)<>5
    OR (SELECT count(*) FROM public.agent_enrollment_tokens WHERE uses=1 AND consumed_at IS NOT NULL)<>3
    OR (SELECT count(*) FROM public.monitored_agents)<>3
    OR (SELECT count(*) FROM public.agent_credentials)<>4
    OR (SELECT count(*) FROM public.agent_credentials WHERE revoked_at IS NOT NULL)<>2
    OR (SELECT count(*) FROM public.audit_events)<>10
    OR (SELECT count(*) FROM public.__drizzle_migrations)<>1
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6 THEN
   RAISE EXCEPTION 'Agent record or historical migration count mismatch';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN
    ('public.agent_credentials'::regclass,'public.agent_enrollment_tokens'::regclass,
     'public.monitored_agents'::regclass,'public.audit_events'::regclass)
    AND NOT (relrowsecurity AND relforcerowsecurity))
    OR has_table_privilege('pulse_metrics_app','pulse_agent_enrollment.schema_migrations','SELECT')
    OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
    OR has_table_privilege('pulse_metrics_app','public.agent_enrollment_tokens','SELECT')
    OR has_table_privilege('pulse_metrics_app','public.agent_credentials','UPDATE')
    OR has_table_privilege('pulse_metrics_app','public.agent_enrollment_tokens','INSERT')
    OR has_table_privilege('pulse_metrics_app','public.monitored_agents','INSERT') THEN
   RAISE EXCEPTION 'Agent secrets exposed to ordinary runtime role';
 END IF;
 IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='pulse_agent_enrollment'::regnamespace
   AND p.prosecdef AND p.proowner='pulse_metrics_agent_enrollment_executor'::regrole
   AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,ARRAY[]::text[])) cfg
     WHERE regexp_replace(cfg,'[[:space:]]','','g')='search_path=pg_catalog,pg_temp'))<>5 THEN
   RAISE EXCEPTION 'Synthetic function security boundaries do not match';
 END IF;
 IF EXISTS (
   SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
   WHERE p.pronamespace='pulse_agent_enrollment'::regnamespace
     AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
 ) THEN
   RAISE EXCEPTION 'PUBLIC can execute a sensitive rehearsal function';
 END IF;
 RAISE NOTICE 'PASS: 3 consumed of 5 tokens (expired/revoked denied), 3 agents, 4 credentials, 10 audit events';
END;
$check$;
COMMIT;
SQL
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
AFTER_CATALOG="$(psql_admin pulse_metrics -Atq < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
# Additional test functions change this private cluster's public-grant manifest,
# so compare ONLY the original development cluster against the pinned baseline.
LAST_MAIN="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$LAST_MAIN" == "$BASELINE" ]] || fail 'Working development database catalog changed'
echo 'PASS: existing development database still matches its original reviewed catalog'
echo '========== PHASE 2E3C5D10 ISOLATED INGRESS MIGRATION REHEARSAL COMPLETE =========='
echo 'NOTE: synthetic WorkOS subjects; no route mounted or live credential issued'
echo 'NOTE: simulated proxy TLS only; no real edge/TLS deployment or approved production migration'

echo '========== PHASE 2E3C5D9 UNMOUNTED HTTP CONTRACT + REAL DATABASE =========='
# The versioned candidate concurrency test and catalog invariants above
# MUST pass before the new HTTP-to-database boundary is exercised. No fixture
# in the working development database is created or altered.
timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES PULSE_AGENT_SOCKET="$SOCKET" PULSE_AGENT_DATA="$DATA" \
  PULSE_AGENT_ORG_A="$ORG_A" PULSE_AGENT_ORG_B="$ORG_B" \
  node --import tsx scripts/agent-enrollment/migration-http-integration.ts

# Additional replay does NOT alter the original Drizzle or six privileged ledgers.
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
LAST_MAIN_HTTP="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$LAST_MAIN_HTTP" == "$BASELINE" ]] || fail 'Development catalog modified by D9 rehearsal'
echo 'PASS: 2E3C5D9 HTTP rehearsal never changed existing development database catalog'
echo 'NOTE: D10 ingress candidate is unmounted; test HTTP routes bound to loopback only'

echo '========== D13 PINNED PREALLOCATED IDENTITY MIGRATION (DISPOSABLE ONLY) =========='
node scripts/agent-identity/verify-candidate.mjs
psql_admin pulse_metrics -q < scripts/agent-identity/migrations/0003_preallocated_identity.sql
psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;
DO $v$
DECLARE r record;
BEGIN
 SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
        rolbypassrls,rolinherit INTO r FROM pg_roles
    WHERE rolname='pulse_metrics_agent_identity_executor';
 IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR
    r.rolreplication OR NOT r.rolbypassrls OR r.rolinherit
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE
      roleid='pulse_metrics_agent_identity_executor'::regrole OR
      member='pulse_metrics_agent_identity_executor'::regrole)
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations)<>3
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations WHERE version IN ('0001','0002','0003'))<>3
    OR (SELECT count(*) FROM public.__drizzle_migrations)<>1
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE
      oid='pulse_agent_enrollment.preallocated_agent_bindings'::regclass
      AND relrowsecurity AND relforcerowsecurity AND relowner='postgres'::regrole)
    OR has_table_privilege('pulse_metrics_app','pulse_agent_enrollment.preallocated_agent_bindings','SELECT')
    OR has_table_privilege('pulse_metrics_app','pulse_agent_enrollment.preallocated_agent_bindings','INSERT')
    OR has_function_privilege('pulse_metrics_app',
      'pulse_agent_enrollment.issue_enrollment(text,uuid,text,text,text,timestamptz)','EXECUTE')
    OR has_function_privilege('pulse_metrics_app',
      'pulse_agent_enrollment.redeem_enrollment(text,text,text,text,text,text,text)','EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE
      oid=to_regprocedure('pulse_agent_enrollment.issue_preallocated_enrollment(text,uuid,text,text,text,timestamptz,text,text,text,text)')
      AND prosecdef AND proowner='pulse_metrics_agent_identity_executor'::regrole
      AND EXISTS (SELECT 1 FROM unnest(coalesce(proconfig,ARRAY[]::text[])) cfg
        WHERE regexp_replace(cfg,'[[:space:]]','','g')='search_path=pg_catalog,pg_temp'))
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE
      oid=to_regprocedure('pulse_agent_enrollment.redeem_preallocated_enrollment(text,text,text,text,text,text,text)')
      AND prosecdef AND proowner='pulse_metrics_agent_identity_executor'::regrole
      AND EXISTS (SELECT 1 FROM unnest(coalesce(proconfig,ARRAY[]::text[])) cfg
        WHERE regexp_replace(cfg,'[[:space:]]','','g')='search_path=pg_catalog,pg_temp') )
    OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
      aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='pulse_agent_enrollment'::regnamespace
      AND p.proname IN ('issue_preallocated_enrollment','redeem_preallocated_enrollment')
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
 THEN RAISE EXCEPTION 'D13 version, executor, grant or RLS invariant failed'; END IF;
 RAISE NOTICE 'PASS: D13 exactly three receipts, retired v1, no direct runtime access, hardened executor';
END;
$v$;
COMMIT;
SQL

echo '========== D13 REAL DATABASE PREAUTHORIZED IDENTITY + RACE TEST =========='
timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES PULSE_AGENT_SOCKET="$SOCKET" PULSE_AGENT_DATA="$DATA" \
  PULSE_AGENT_ORG_A="$ORG_A" PULSE_AGENT_ORG_B="$ORG_B" \
  node scripts/agent-identity/integration.mjs

LAST_MAIN_D13="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$LAST_MAIN_D13" == "$BASELINE" ]] || fail 'Main development database catalog changed in D13 rehearsal'
echo 'PASS: main database catalog unchanged; D13 SQL and fixtures remained in disposable socket-only cluster'
echo 'PASS: disposable cluster cleanup remains attached to original EXIT trap'
echo 'PUBLIC LAUNCH: NO_GO — NO production migration applied and NO public enrollment routes activated'
