#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2B2 — ONLY inspect the incomplete 5U2 cluster.
# Temporary local-only PostgreSQL start, read-only catalog queries, mandatory
# stop and repeat offline verification. Never migrates, repairs or seeds.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

refuse() { printf 'REFUSE_D15C5U2B2: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 0 ]] || refuse 'No arguments accepted'
[[ "$(uname -s)" == Linux && "$(id -u)" -ne 0 ]] || refuse 'Linux non-root operator required'
[[ "${NODE_ENV:-development}" != production && -z "${NODE_OPTIONS:-}" ]] || refuse 'Production or NODE_OPTIONS refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited database URL refused'
for bin in sudo pg_config psql stat sha256sum grep cut; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing prerequisite: $bin"
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
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" ]] || refuse 'PostgreSQL binaries missing'
[[ -f "$OFFLINE" && ! -L "$OFFLINE" ]] || refuse 'Original offline inspection script missing or linked'
[[ "$(sha256sum "$OFFLINE" | cut -d' ' -f1)" == "$OFFLINE_HASH" ]] || refuse 'Offline inspection changed'

# This script from 5U-2B1 checks the marker, permissions, no ready marker,
# clean stop, exact Unix-socket configuration and original DB fingerprint.
echo '========== VERIFY PREVIOUS OFFLINE INSPECTION =========='
bash "$OFFLINE"

START_ATTEMPTED=0
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if (( START_ATTEMPTED )); then
    echo '========== MANDATORY CLUSTER SHUTDOWN =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      if ! sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop; then
        echo 'CRITICAL: PostgreSQL stop failed; investigate before any further action' >&2
        code=1
      fi
    fi
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      echo 'CRITICAL: retained cluster still running; manual investigation required' >&2
      code=1
    else
      echo 'PASS: retained PostgreSQL cluster is not running'
    fi
    echo '========== RECHECK OFFLINE INVARIANTS =========='
    if ! bash "$OFFLINE"; then
      echo 'STOP: post-inspection safety recheck failed' >&2
      code=1
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# No pending SQL or other work is allowed before the identity is proven.
# Starting PostgreSQL updates only its own operational files/WAL; all SQL
# performed below is explicitly read-only.
echo '========== TEMPORARILY START RETAINED CLUSTER =========='
START_ATTEMPTED=1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/server.log" -w start >/dev/null

psql_admin() {
  local database="$1"; shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$database" "$@"
}

# Exact path and local-only connection verified using *postgres* administrator;
# the restricted migrator is never asked to read data_directory.
echo '========== VERIFIED CLUSTER IDENTITY (POSTGRES ADMIN ONLY) =========='
psql_admin postgres <<'SQL'
BEGIN READ ONLY;
DO $verify$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres'
     OR current_setting('data_directory') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
     OR current_setting('unix_socket_directories') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/socket'
     OR current_setting('port') <> '55433'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL
     OR inet_server_port() IS NOT NULL
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5U2B2: unexpected server identity/network';
  END IF;
  IF (SELECT count(*) FROM pg_database WHERE datname='pulse_metrics') <> 1 THEN
    RAISE EXCEPTION 'REFUSE_D15C5U2B2: expected application database missing';
  END IF;
  RAISE NOTICE 'PASS: expected separate PostgreSQL data directory; no TCP listener';
END;
$verify$;
COMMIT;
SQL

# Admin-only SQL inventory. Every statement is in one read-only transaction;
# the checks deliberately accept ONLY the precise bootstrap-only state.
echo '========== RETAINED CLUSTER DATABASE INVENTORY (READ ONLY) =========='
psql_admin pulse_metrics <<'SQL'
BEGIN READ ONLY;

SELECT current_database() AS database, current_user AS verified_admin,
       current_setting('transaction_read_only') AS read_only;

SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolbypassrls, rolinherit
FROM pg_roles
WHERE rolname LIKE 'pulse_metrics%'
ORDER BY rolname;

SELECT n.nspname AS schema, c.relname AS object_name, c.relkind AS object_type
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
ORDER BY c.relname;

SELECT nspname AS optional_schema
FROM pg_namespace
WHERE nspname IN (
 'pulse_security_migrations',
 'pulse_agent_enrollment',
 'pulse_telemetry_ingestion',
 'pulse_telemetry_quota',
 'pulse_telemetry_agent_quota'
)
ORDER BY nspname;

DO $verify$
DECLARE r record;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR current_setting('data_directory') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
     OR current_setting('unix_socket_directories') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/socket'
     OR current_setting('port') <> '55433'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'REFUSE_D15C5U2B2: unexpected database/server identity';
  END IF;
  IF to_regclass('public.__drizzle_migrations') IS NOT NULL
     OR to_regclass('public.organizations') IS NOT NULL
     OR to_regclass('public.monitored_agents') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
       WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f'))
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN
       ('pulse_security_migrations','pulse_agent_enrollment',
        'pulse_telemetry_ingestion','pulse_telemetry_quota',
        'pulse_telemetry_agent_quota'))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
       WHERE n.nspname='public' AND p.proname IN
       ('resolve_workos_user','create_workos_organization',
        'consume_invitation_rate_limit'))
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5U2B2: SQL objects already exist; no automatic recovery';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN
        ('pulse_metrics_migrator','pulse_metrics_app')) <> 2
     OR EXISTS (
       SELECT 1 FROM pg_roles WHERE rolname IN ('pulse_metrics_migrator','pulse_metrics_app')
       AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
          OR rolbypassrls OR rolinherit))
     OR EXISTS (
       SELECT 1 FROM pg_roles WHERE rolname LIKE 'pulse_metrics%'
       AND rolname NOT IN ('pulse_metrics_migrator','pulse_metrics_app'))
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5U2B2: unexpected role state';
  END IF;
  RAISE NOTICE 'PASS: exactly two restricted bootstrap roles and no Drizzle, tenant or protected telemetry objects';
END;
$verify$;

COMMIT;
SQL

echo '========== D15C-5U-2B2 RETAINED SQL INSPECTION: PASS =========='
echo 'PASS: bootstrap-only cluster state verified using read-only administrator SQL'
echo 'NOTE: no migrations, fixtures, credential changes or permission grants performed'
echo 'PUBLIC LAUNCH: NO_GO'
