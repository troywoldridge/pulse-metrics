#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2B3C — QUARANTINED persistent cluster SQL inventory.
# No migrations, fixes, fixtures, permissions changes, or application activation.
# Temporary, verified local-only start; read-only SQL; mandatory cluster stop.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
refuse() { printf 'REFUSE_D15C5U2B3C: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 0 ]] || refuse 'No arguments are accepted'
[[ "$(uname -s)" == 'Linux' && "$(id -u)" -ne 0 ]] || refuse 'Linux non-root operator required'
[[ "${NODE_ENV:-development}" != 'production' && -z "${NODE_OPTIONS:-}" ]] || refuse 'Production mode or NODE_OPTIONS refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited database URLs refused'
for cmd in sudo pg_config sha256sum cut; do
  command -v "$cmd" >/dev/null 2>&1 || refuse "Missing prerequisite: $cmd"
done
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA || true

BASE='/var/lib/postgresql/pulse-metrics-dev-5u2'
DATA="$BASE/data"
SOCKET="$BASE/socket"
PORT=55433
PG_BIN="$(pg_config --bindir)"
OFFLINE='scripts/telemetry-dev/inspect-incomplete-persistent-development.sh'
OFFLINE_HASH='7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" && -x "$PG_BIN/postgres" ]] || refuse 'PostgreSQL server utilities unavailable'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'PostgreSQL major version changed'
[[ -f "$OFFLINE" && ! -L "$OFFLINE" ]] || refuse 'Verified offline checker absent or linked'
[[ "$(sha256sum "$OFFLINE" | cut -d' ' -f1)" == "$OFFLINE_HASH" ]] || refuse 'Offline checker source changed'

# Revalidate ownership, marker, clean shutdown, socket-only settings, and
# the original, separate development database's pinned catalog fingerprint.
echo '========== 1. VERIFY STOPPED QUARANTINED CLUSTER =========='
bash "$OFFLINE"

START_ATTEMPTED=0
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if (( START_ATTEMPTED )); then
    echo '========== MANDATORY SHUTDOWN OF QUARANTINED CLUSTER =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      if ! sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop; then
        echo 'CRITICAL: retained cluster could not be stopped' >&2
        code=1
      fi
    fi
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      echo 'CRITICAL: retained cluster remains running' >&2
      code=1
    else
      echo 'PASS: quarantined cluster is stopped'
      echo '========== FINAL OFFLINE SECURITY CHECK =========='
      if ! bash "$OFFLINE"; then
        echo 'STOP: final offline check failed' >&2
        code=1
      fi
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

psql_admin() {
  local database="$1"
  shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$database" "$@"
}

echo '========== 2. TEMPORARY LOCAL-ONLY POSTGRESQL START =========='
START_ATTEMPTED=1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/server.log" -w start >/dev/null

# Postgres administrator, never the ordinary runtime/migration role, examines
# protected settings. The target must be exactly the dedicated retained cluster.
echo '========== 3. VERIFY EXACT SERVER IDENTITY =========='
psql_admin postgres <<'SQL'
BEGIN READ ONLY;
DO $identity$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres'
     OR current_setting('data_directory') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
     OR current_setting('unix_socket_directories') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/socket'
     OR current_setting('port') <> '55433'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2B3C: unexpected database server'; END IF;
  RAISE NOTICE 'PASS: exact quarantined cluster, Unix socket only, administrator identity';
END;
$identity$;
COMMIT;
SQL

echo '========== 4. READ-ONLY SQL INVENTORY =========='
psql_admin pulse_metrics <<'SQL'
BEGIN READ ONLY;
DO $identity$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR current_setting('data_directory') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
     OR current_setting('unix_socket_directories') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/socket'
     OR current_setting('port') <> '55433'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
  THEN RAISE EXCEPTION 'REFUSE_D15C5U2B3C: unexpected target database'; END IF;
END;
$identity$;

SELECT current_database() AS db, current_user AS administrator,
       current_setting('transaction_read_only') AS read_only;

SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
FROM pg_roles WHERE rolname LIKE 'pulse_metrics%' ORDER BY rolname;

SELECT nspname AS installed_protected_schema
FROM pg_namespace WHERE nspname IN (
  'pulse_security_migrations',
  'pulse_agent_enrollment',
  'pulse_telemetry_ingestion',
  'pulse_telemetry_quota',
  'pulse_telemetry_agent_quota'
) ORDER BY nspname;

SELECT n.nspname AS schema, c.relname AS relation,
       pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE (n.nspname = 'public' AND c.relname IN (
          'monitored_agents', 'telemetry_samples', 'agent_credentials',
          '__drizzle_migrations'))
   OR (n.nspname IN ('pulse_security_migrations', 'pulse_agent_enrollment',
         'pulse_telemetry_ingestion', 'pulse_telemetry_quota',
         'pulse_telemetry_agent_quota') AND c.relkind IN ('r','p'))
ORDER BY n.nspname, c.relname;

DO $inventory$
DECLARE target text; total bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.__drizzle_migrations',
    'pulse_security_migrations.applied_privileged_steps',
    'pulse_agent_enrollment.schema_migrations',
    'pulse_telemetry_ingestion.schema_migrations',
    'pulse_telemetry_quota.schema_migrations',
    'pulse_telemetry_agent_quota.schema_migrations',
    'public.organizations',
    'public.monitored_agents',
    'public.telemetry_samples',
    'pulse_telemetry_ingestion.submissions'
  ] LOOP
    IF to_regclass(target) IS NULL THEN
      RAISE NOTICE 'ABSENT: %', target;
    ELSE
      EXECUTE format('SELECT count(*) FROM %s', to_regclass(target)) INTO total;
      RAISE NOTICE 'ROW COUNT: % = %', target, total;
    END IF;
  END LOOP;
END;
$inventory$;

-- The expected early-stop shape is deliberately *not* an authorization to
-- continue migrations. This assertion guards inventory quality only.
DO $audit$
BEGIN
  IF to_regclass('public.__drizzle_migrations') IS NULL OR
     to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL OR
     to_regclass('pulse_agent_enrollment.schema_migrations') IS NULL OR
     to_regclass('pulse_telemetry_ingestion.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'UNEXPECTED_PARTIAL_STATE: required earlier migration objects missing';
  END IF;
  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1 OR
     (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6 OR
     (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 1 OR
     (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1 OR
     to_regnamespace('pulse_telemetry_quota') IS NOT NULL OR
     to_regnamespace('pulse_telemetry_agent_quota') IS NOT NULL OR
     has_schema_privilege('pulse_metrics_app','pulse_security_migrations','USAGE') OR
     has_any_column_privilege('pulse_metrics_app','public.agent_credentials','SELECT') OR
     has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT') OR
     EXISTS (SELECT 1 FROM pg_class WHERE oid IN (
       'public.monitored_agents'::regclass,
       'public.telemetry_samples'::regclass,
       'public.agent_credentials'::regclass
     ) AND NOT (relrowsecurity AND relforcerowsecurity)) THEN
    RAISE EXCEPTION 'UNEXPECTED_PARTIAL_STATE: migration or security invariants differ';
  END IF;
  RAISE NOTICE 'PASS: expected partial migration state; NOT approved for telemetry usage or recovery';
END;
$audit$;
COMMIT;
SQL

echo '========== D15C-5U-2B3C QUARANTINED SQL INVENTORY: PASS =========='
echo 'NO MIGRATIONS | NO REPAIR | NO AGENT ENROLLMENT | NO PUBLIC LAUNCH'
