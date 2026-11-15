#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F1: guarded operator controls for ONE local development cluster.
# Not a production service. Does not create a ready marker, credentials, agents,
# telemetry, fixtures, backups, jobs, public routes, or network listeners.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2F1: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 && "${1:-}" =~ ^(--plan|--status|--start|--audit|--stop)$ ]] || refuse 'Use exactly --plan|--status|--start|--audit|--stop'
MODE="$1"
[[ "$(uname -s)" == Linux && "$(id -u)" -ne 0 ]] || refuse 'Linux non-root operator required'
[[ "${NODE_ENV:-development}" != production && -z "${NODE_OPTIONS:-}" ]] || refuse 'Production and inherited Node options refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited DB URLs refused'
[[ "${PULSE_ENABLE_PUBLIC_INGRESS:-}" != YES && "${PULSE_ENABLE_TELEMETRY_SERVICE:-}" != YES ]] || refuse 'No HTTP or telemetry activation permitted'
if [[ "$MODE" == --start ]]; then
  [[ "${PULSE_APPROVE_5U2F_LOCAL_START:-}" == EXACT_SOCKET_ONLY ]] || refuse 'Separate EXACT_SOCKET_ONLY approval required'
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
for bin in sudo pg_config sha256sum cut stat grep; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing required tool: $bin"
done
# Prevent libpq configuration inherited from the operator environment from
# selecting the wrong PostgreSQL server, credentials, or transport.
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
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" && -x "$PG_BIN/postgres" ]] || refuse 'PostgreSQL server utilities missing'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'Requires PostgreSQL major 16'
[[ -f "$OFFLINE" && ! -L "$OFFLINE" && "$(sha256sum "$OFFLINE" | cut -d' ' -f1)" == "$OFFLINE_SHA" ]] || refuse 'Offline inspector not byte-identical to reviewed source'

# The cluster retains its incomplete-provisioning marker, intentionally.
# A readiness marker is never created by this operator or assumed valid.
quarantine_guard() {
  # The private data directory is 0700, so tests must run as postgres.
  for target in "$BASE" "$DATA" "$SOCKET"; do
    sudo -u postgres test -d "$target" && sudo -u postgres test ! -L "$target" ||
      refuse 'Unexpected, missing or linked cluster location'
  done
  [[ "$(sudo -u postgres stat -c '%U:%a' "$BASE")" == postgres:750 ]] || refuse 'Base ownership or mode changed'
  [[ "$(sudo -u postgres stat -c '%U:%a' "$DATA")" == postgres:700 ]] || refuse 'Data ownership or mode changed'
  [[ "$(sudo -u postgres stat -c '%U:%a' "$SOCKET")" == postgres:750 ]] || refuse 'Socket ownership or mode changed'
  [[ "$(sudo -u postgres stat -c '%U:%a' "$BASE/.pulse-5u2-provisioning")" == postgres:600 ]] || refuse 'Provisioning marker missing or unsafe'
  if ! sudo -u postgres test ! -e "$BASE/.pulse-5u2-ready" || ! sudo -u postgres test ! -L "$BASE/.pulse-5u2-ready"; then
    refuse 'Unexpected ready marker: this operator is quarantine-only'
  fi
  # In emergency shutdown mode, avoid letting a changed TCP setting block
  # the administrator from stopping the exact pinned cluster.
  [[ "$MODE" == --stop ]] && return 0
  sudo -u postgres grep -Fx -- "listen_addresses = ''" "$DATA/postgresql.conf" >/dev/null || refuse 'TCP configuration changed'
  sudo -u postgres grep -Fx -- "unix_socket_directories = '$SOCKET'" "$DATA/postgresql.conf" >/dev/null || refuse 'Socket configuration changed'
  sudo -u postgres grep -Fx -- 'port = 55433' "$DATA/postgresql.conf" >/dev/null || refuse 'Port configuration changed'
  sudo -u postgres grep -Fx -- 'host all all 0.0.0.0/0 reject' "$DATA/pg_hba.conf" >/dev/null || refuse 'IPv4 host rejection removed'
  sudo -u postgres grep -Fx -- 'host all all ::/0 reject' "$DATA/pg_hba.conf" >/dev/null || refuse 'IPv6 host rejection removed'
}

is_running() { sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }
psql_admin() {
  local db="$1"
  shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$db" "$@"
}

verify_running_identity() {
  local actual
  actual="$(psql_admin postgres -Atq -c "
    SELECT current_database() || '|' || current_user || '|' ||
      current_setting('data_directory') || '|' ||
      current_setting('unix_socket_directories') || '|' ||
      current_setting('port') || '|' ||
      (current_setting('listen_addresses')='')::text || '|' ||
      (inet_server_addr() IS NULL)::text || '|' ||
      (inet_server_port() IS NULL)::text")" || refuse 'Administrator connection failed'
  [[ "$actual" == "postgres|postgres|$DATA|$SOCKET|$PORT|true|true|true" ]] || refuse 'PostgreSQL target, socket or TCP guard mismatch'
  echo 'PASS: exact PostgreSQL 16 data directory, socket and port; TCP disabled'
}

verify_database_read_only() {
  psql_admin pulse_metrics <<'SQL'
BEGIN READ ONLY;
DO $audit$
DECLARE
  v_ingest oid;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR current_setting('transaction_read_only') <> 'on'
     OR current_setting('data_directory') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
     OR current_setting('unix_socket_directories') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/socket'
     OR current_setting('port') <> '55433'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
  THEN RAISE EXCEPTION '5U2F1: unexpected database connection'; END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps WHERE recorded_mode='fresh_replay') <> 6
    OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 1
    OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
    OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
    OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
    OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0002')
  THEN RAISE EXCEPTION '5U2F1: receipt mismatch'; END IF;

  IF EXISTS (
     SELECT 1 FROM pg_roles
      WHERE rolname IN ('pulse_metrics_app','pulse_metrics_migrator')
        AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit))
     OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
     OR has_schema_privilege('pulse_metrics_app','pulse_security_migrations','USAGE')
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_agent_quota','USAGE')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_quota.network_buckets','SELECT')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_agent_quota.agent_buckets','SELECT')
  THEN RAISE EXCEPTION '5U2F1: runtime least privilege regression'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relkind IN ('r','p')
       AND (n.nspname IN ('pulse_security_migrations','pulse_agent_enrollment',
             'pulse_telemetry_ingestion','pulse_telemetry_quota','pulse_telemetry_agent_quota')
          OR (n.nspname='public' AND c.relname IN
             ('agent_credentials','monitored_agents','telemetry_samples')))
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  ) THEN RAISE EXCEPTION '5U2F1: forced RLS missing'; END IF;

  v_ingest := to_regprocedure('pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)');
  IF v_ingest IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=v_ingest
      AND p.prosecdef AND p.proowner='pulse_metrics_telemetry_executor'::regrole
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN RAISE EXCEPTION '5U2F1: ingestion SECURITY DEFINER regression'; END IF;

  IF (SELECT count(*) FROM public.users) <> 0
    OR (SELECT count(*) FROM public.organizations) <> 0
    OR (SELECT count(*) FROM public.monitored_agents) <> 0
    OR (SELECT count(*) FROM public.agent_credentials) <> 0
    OR (SELECT count(*) FROM public.telemetry_samples) <> 0
    OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 0
    OR (SELECT count(*) FROM pulse_telemetry_quota.network_buckets) <> 0
    OR (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets) <> 0
  THEN RAISE EXCEPTION '5U2F1: unexpected operational data'; END IF;

  RAISE NOTICE 'PASS: schema receipts, FORCE RLS, privilege separation and zero operational rows';
END;
$audit$;
COMMIT;
SQL
  # Check the effective restricted role; don't rely only on ACL introspection.
  local denial
  if denial="$(psql_admin pulse_metrics -v VERBOSITY=verbose -c \
    'SET ROLE pulse_metrics_app; SELECT count(*) FROM public.agent_credentials;' 2>&1)"; then
    refuse 'Ordinary runtime unexpectedly read credentials'
  fi
  [[ "$denial" == *'42501:'* ]] || refuse 'Runtime credential denial did not produce SQLSTATE 42501'
  echo 'PASS: real restricted role denied direct credential reads'
}

quarantine_guard
case "$MODE" in
  --plan)
    bash "$OFFLINE"
    echo '========== D15C-5U-2F1 PLAN =========='
    echo 'Operate only the dedicated persistent local-development PostgreSQL cluster.'
    echo 'Before --start: repeat offline original-database fingerprint and clean-stop checks.'
    echo 'After --start: assert true socket-only identity, migrations, RLS, ACL and zero rows.'
    echo 'On failed start/audit: stop the cluster; on success leave local-only DB running.'
    echo 'With --stop: shut down the verified local cluster and recheck baseline.'
    echo 'Does not create a ready marker, a telemetry route, customer credentials or data.'
    echo 'Public launch NO_GO; this is not backup retention or production approval.'
    echo 'NO POSTGRESQL STARTED BY PLAN'
    ;;
  --status)
    if is_running; then
      verify_running_identity
      verify_database_read_only
      echo 'PASS: development cluster is running locally; telemetry remains unapproved'
    else
      bash "$OFFLINE"
      echo 'PASS: development cluster is stopped and quarantined'
    fi
    ;;
  --start)
    is_running && refuse 'Cluster already running; use --status or --stop'
    bash "$OFFLINE"
    echo '========== START VERIFIED LOCAL-ONLY DEVELOPMENT POSTGRESQL =========='
    SUCCESS=0
    START_ATTEMPTED=0
    cleanup() {
      local code=$?
      trap - EXIT INT TERM
      set +e
      if (( ! SUCCESS && START_ATTEMPTED )); then
        echo '========== START FAILED: MANDATORY LOCAL CLUSTER SHUTDOWN =========='
        if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
          sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop || code=1
        fi
        if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
          echo 'CRITICAL: cluster still running' >&2
          code=1
        else
          bash "$OFFLINE" || code=1
        fi
      fi
      exit "$code"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    START_ATTEMPTED=1
    sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/server.log" -w start >/dev/null
    verify_running_identity
    verify_database_read_only
    SUCCESS=1
    echo '========== LOCAL-ONLY DEVELOPMENT POSTGRESQL START: PASS =========='
    echo 'No API started | No agent enrolled | No ready marker | PUBLIC LAUNCH: NO_GO'
    ;;
  --audit)
    is_running || refuse 'Cluster stopped; cannot audit live database'
    verify_running_identity
    verify_database_read_only
    echo 'PASS: running local-only development PostgreSQL security audit'
    ;;
  --stop)
    is_running || refuse 'Cluster already stopped'
    echo '========== STOP DEDICATED DEVELOPMENT POSTGRESQL =========='
    # For emergency shutdown, don't leave a server running just because a SQL
    # security assertion would fail. pg_ctl uses only the pinned, owner-only DATA.
    sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null
    is_running && refuse 'PostgreSQL remained running after stop'
    bash "$OFFLINE"
    echo 'PASS: dedicated PostgreSQL cluster stopped; still quarantined'
    ;;
esac
