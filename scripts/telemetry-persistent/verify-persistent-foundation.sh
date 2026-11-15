#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2E1 — quarantine-preserving, READ-ONLY SQL restart verification.
# The only system changes are PostgreSQL's necessary temporary start/stop operations.
# No user fixtures, SQL writes, ready marker, enrollment, or exposed network service.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2E1: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 && ( "$1" == '--plan' || "$1" == '--verify' ) ]] || refuse 'Use exactly --plan or --verify'
MODE="$1"
[[ "$(uname -s)" == 'Linux' && "$(id -u)" -ne 0 ]] || refuse 'Non-root Linux operator required'
[[ "${NODE_ENV:-development}" != production && -z "${NODE_OPTIONS:-}" ]] || refuse 'Production or NODE_OPTIONS environment refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited database URLs refused'
if [[ "$MODE" == '--verify' ]]; then
  [[ "${PULSE_APPROVE_5U2E_READ_ONLY:-}" == 'YES' ]] || refuse 'Explicit read-only verification approval required'
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
for tool in sudo pg_config sha256sum node cut; do
  command -v "$tool" >/dev/null 2>&1 || refuse "Missing prerequisite: $tool"
done
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA PGCONNECT_TIMEOUT || true

BASE='/var/lib/postgresql/pulse-metrics-dev-5u2'
DATA="$BASE/data"
SOCKET="$BASE/socket"
PORT=55433
OFFLINE='scripts/telemetry-dev/inspect-incomplete-persistent-development.sh'
OFFLINE_SHA='7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" && -x "$PG_BIN/postgres" ]] || refuse 'PostgreSQL tools unavailable'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'Expected PostgreSQL 16'
[[ -f "$OFFLINE" && ! -L "$OFFLINE" && "$(sha256sum "$OFFLINE" | cut -d' ' -f1)" == "$OFFLINE_SHA" ]] || refuse 'Offline inspector changed or missing'
[[ ! -e "$BASE/.pulse-5u2-ready" && ! -L "$BASE/.pulse-5u2-ready" ]] || refuse 'Cluster has a readiness marker; quarantine check refused'

echo '========== VERIFY IMMUTABLE DEVELOPMENT SQL CANDIDATES =========='
node scripts/telemetry-persistent/release-candidates.mjs --verify

echo '========== VERIFY STOPPED, QUARANTINED CLUSTER =========='
bash "$OFFLINE"

if [[ "$MODE" == '--plan' ]]; then
  echo '========== D15C-5U-2E1 VERIFICATION PLAN =========='
  echo 'Two controlled local-only PostgreSQL start/stop cycles'
  echo 'Exact administrator database/socket/data-directory identity checked'
  echo 'Read-only checks: all migration receipts, FORCE RLS, runtime ACL and zero data'
  echo 'Restricted application-role login and denial of credential-table reads'
  echo 'Compare durable migration receipt fingerprint across restart'
  echo 'Independently confirm original development database catalog after each stop'
  echo 'No backup yet, no telemetry, no ready marker, no persistent service'
  echo 'NO SERVER STARTED | PUBLIC LAUNCH: NO_GO'
  exit 0
fi

START_ATTEMPTED=0
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if (( START_ATTEMPTED )); then
    echo '========== GUARANTEED QUARANTINE SHUTDOWN =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop || code=1
    fi
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      echo 'CRITICAL: PostgreSQL cluster remains running' >&2
      code=1
    else
      echo 'PASS: cluster stopped'
      bash "$OFFLINE" || code=1
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

psql_admin() {
  local db="$1"
  shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$db" "$@"
}

check_running_cluster() {
  local identity
  identity="$(psql_admin postgres -Atq -c "
    BEGIN READ ONLY;
    SELECT current_database() || '|' || current_user || '|' ||
      current_setting('data_directory') || '|' ||
      current_setting('unix_socket_directories') || '|' ||
      current_setting('port') || '|' ||
      (current_setting('listen_addresses')='')::text || '|' ||
      (inet_server_addr() IS NULL)::text || '|' ||
      (inet_server_port() IS NULL)::text;
    COMMIT;
  ")" || refuse 'Administrator target identity check failed'
  [[ "$identity" == "postgres|postgres|$DATA|$SOCKET|$PORT|true|true|true" ]] || refuse 'Unexpected PostgreSQL target identity'
  echo 'PASS: exact separate cluster, local Unix socket, TCP disabled'
}

verify_sql_security() {
  psql_admin pulse_metrics <<'SQL'
BEGIN READ ONLY;
DO $audit$
DECLARE
  v_function oid;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR current_setting('transaction_read_only') <> 'on'
     OR current_setting('data_directory') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
     OR current_setting('unix_socket_directories') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/socket'
     OR current_setting('port') <> '55433'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
  THEN RAISE EXCEPTION 'D15C5U2E1: wrong connection or not read-only'; END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps WHERE recorded_mode='fresh_replay') <> 6
     OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_agent_enrollment.schema_migrations WHERE version='0001')
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_ingestion.schema_migrations WHERE version='0001')
     OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_quota.schema_migrations WHERE version='0001')
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0001')
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0002')
  THEN RAISE EXCEPTION 'D15C5U2E1: migration receipts incomplete'; END IF;

  IF (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'pulse_metrics%') <> 12
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('pulse_metrics_app','pulse_metrics_migrator')
       AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit))
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_app' AND rolcanlogin)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_migrator' AND rolcanlogin)
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'pulse_metrics%executor'
       AND (rolcanlogin OR rolsuper OR rolinherit))
  THEN RAISE EXCEPTION 'D15C5U2E1: unexpected PostgreSQL roles'; END IF;

  IF has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
     OR has_schema_privilege('pulse_metrics_app','pulse_security_migrations','USAGE')
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_agent_quota','USAGE')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_quota.network_buckets','SELECT')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_agent_quota.agent_buckets','SELECT')
     OR pg_has_role('pulse_metrics_app','pulse_metrics_telemetry_executor','MEMBER')
     OR pg_has_role('pulse_metrics_app','pulse_metrics_telemetry_agent_quota_executor','MEMBER')
  THEN RAISE EXCEPTION 'D15C5U2E1: runtime privileges too broad'; END IF;

  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE c.relkind IN ('r','p') AND
           ((n.nspname='public' AND c.relname IN ('agent_credentials','monitored_agents','telemetry_samples'))
            OR n.nspname IN ('pulse_security_migrations','pulse_agent_enrollment',
                 'pulse_telemetry_ingestion','pulse_telemetry_quota','pulse_telemetry_agent_quota'))
         AND c.relrowsecurity AND c.relforcerowsecurity) < 10
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE c.relkind IN ('r','p')
         AND (n.nspname IN ('pulse_security_migrations','pulse_agent_enrollment',
              'pulse_telemetry_ingestion','pulse_telemetry_quota','pulse_telemetry_agent_quota')
              OR (n.nspname='public' AND c.relname IN ('agent_credentials','monitored_agents','telemetry_samples')))
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity))
  THEN RAISE EXCEPTION 'D15C5U2E1: FORCE RLS missing'; END IF;

  v_function := to_regprocedure(
    'pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)');
  IF v_function IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=v_function AND p.prosecdef
      AND p.proowner='pulse_metrics_telemetry_executor'::regrole
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN RAISE EXCEPTION 'D15C5U2E1: protected ingestion function invalid'; END IF;

  IF (SELECT count(*) FROM public.users) <> 0
     OR (SELECT count(*) FROM public.organizations) <> 0
     OR (SELECT count(*) FROM public.organization_memberships) <> 0
     OR (SELECT count(*) FROM public.monitored_agents) <> 0
     OR (SELECT count(*) FROM public.agent_credentials) <> 0
     OR (SELECT count(*) FROM public.agent_enrollment_tokens) <> 0
     OR (SELECT count(*) FROM public.telemetry_samples) <> 0
     OR (SELECT count(*) FROM public.audit_events) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_quota.network_buckets) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets) <> 0
  THEN RAISE EXCEPTION 'D15C5U2E1: unexpected operational records'; END IF;

  RAISE NOTICE 'PASS: migration receipts, forced RLS, restricted roles/ACL, no operational records';
END;
$audit$;
COMMIT;
SQL
  psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
  psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql
}

# Verify the exact restricted runtime role over the configured peer-authenticated
# Unix socket. No inherited DATABASE_URL and no password or credential input.
psql_app() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -Atq \
    -h "$SOCKET" -p "$PORT" -U pulse_metrics_app -d pulse_metrics "$@"
}

verify_restricted_runtime() {
  local role_identity
  role_identity="$(psql_app -c "
    BEGIN READ ONLY;
    SELECT current_database() || '|' || current_user || '|' ||
           (inet_server_addr() IS NULL)::text;
    COMMIT;
  ")" || refuse 'Restricted runtime login unavailable'
  [[ "$role_identity" == 'pulse_metrics|pulse_metrics_app|true' ]] || refuse 'Restricted runtime connected to wrong target'
  if psql_app -c 'BEGIN READ ONLY; SELECT count(*) FROM public.agent_credentials; COMMIT;' >/dev/null 2>&1; then
    refuse 'Restricted runtime unexpectedly read private credential table'
  fi
  echo 'PASS: restricted runtime connected on Unix socket; direct credential reads refused'
}

receipt_fingerprint() {
  psql_admin pulse_metrics -Atq -c "
    BEGIN READ ONLY;
    SELECT encode(sha256(convert_to(jsonb_build_object(
      'drizzle', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
                   FROM public.__drizzle_migrations x),
      'privileged', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version)
                        FROM pulse_security_migrations.applied_privileged_steps x),
      'enrollment', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version)
                        FROM pulse_agent_enrollment.schema_migrations x),
      'ingestion', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version)
                        FROM pulse_telemetry_ingestion.schema_migrations x),
      'network', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version)
                        FROM pulse_telemetry_quota.schema_migrations x),
      'agent', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version)
                        FROM pulse_telemetry_agent_quota.schema_migrations x)
      )::text, 'UTF8')), 'hex');
    COMMIT;
  "
}

first=''
for cycle in 1 2; do
  echo "========== TEMPORARY POSTGRESQL START $cycle/2 =========="
  START_ATTEMPTED=1
  sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/server.log" -w start >/dev/null
  check_running_cluster
  echo '========== READ-ONLY SECURITY AUDIT =========='
  verify_sql_security
  verify_restricted_runtime
  fingerprint="$(receipt_fingerprint)" || refuse 'Receipt fingerprint query failed'
  [[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] || refuse 'Invalid durable receipt fingerprint'
  if [[ "$cycle" -eq 1 ]]; then
    first="$fingerprint"
  else
    [[ "$first" == "$fingerprint" ]] || refuse 'Migration receipt fingerprint changed across restart'
    echo 'PASS: persistent migration receipts identical after PostgreSQL restart'
  fi
  echo '========== CONTROLLED POSTGRESQL SHUTDOWN =========='
  sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null
  bash "$OFFLINE"
  START_ATTEMPTED=0
done

echo '========== D15C-5U-2E1 RESTART AND SECURITY VERIFICATION: PASS =========='
echo 'PASS: two restarts, unchanged receipts, security checks and original database fingerprint'
echo 'NO CUSTOMER DATA | NO BACKUP TEST YET | NO READY MARKER | PUBLIC LAUNCH: NO_GO'
