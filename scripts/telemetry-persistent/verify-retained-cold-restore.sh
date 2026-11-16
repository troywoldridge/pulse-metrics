#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F2C — restore TEST FROM IMMUTABLE RETAINED COLD SNAPSHOT.
# Read only: dedicated STOPPED source + previously retained 5U-2F2B backup.
# Runs PostgreSQL only on a separate owner-only temporary COPY of the backup.
# No DB migrations, telemetry writes, enrollment, public port, or ready marker.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2F2C: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 && ( "$1" == '--plan' || "$1" == '--verify' ) ]] || refuse 'Use exactly --plan or --verify'
MODE="$1"
[[ "$(uname -s)" == Linux && "$(id -u)" -ne 0 ]] || refuse 'Non-root Linux operator required'
[[ "${NODE_ENV:-development}" != production && -z "${NODE_OPTIONS:-}" ]] || refuse 'Production or NODE_OPTIONS environment refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited DB connection URLs refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 ]] || refuse 'Unsafe TLS override refused'
[[ "${PULSE_ENABLE_PUBLIC_INGRESS:-}" != YES && "${PULSE_ENABLE_TELEMETRY_SERVICE:-}" != YES ]] || refuse 'Telemetry activation refused'
if [[ "$MODE" == '--verify' ]]; then
  [[ "${PULSE_APPROVE_5U2F2C_RETAINED_RESTORE:-}" == 'COPY_RETAINED_SNAPSHOT_ONLY' ]] || refuse 'Explicit retained-copy restore approval required'
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
for tool in sudo pg_config stat sha256sum find sort xargs df du awk cut tr mktemp cp rm sed; do
  command -v "$tool" >/dev/null 2>&1 || refuse "Missing requirement: $tool"
done
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA PGCONNECT_TIMEOUT || true

SOURCE_BASE='/var/lib/postgresql/pulse-metrics-dev-5u2'
BACKUP_BASE='/var/lib/postgresql/pulse-metrics-dev-5u2-cold-backup-5u2f2b'
BACKUP_DATA="$BACKUP_BASE/data"
BACKUP_SCRIPT='scripts/telemetry-persistent/retained-local-cold-snapshot.sh'
BACKUP_SCRIPT_SHA='2e4c2d09044e85bc7b20ee3de451b549b958580ccf80c957fcf303bb5414d904'
RESTORE_PORT=55435
OFFLINE='scripts/telemetry-dev/inspect-incomplete-persistent-development.sh'
OFFLINE_SHA='7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'
VERIFY='scripts/telemetry-persistent/verify-persistent-foundation.sh'
VERIFY_SHA='df5aef0ca4d5c1484f8eb22d522a7e8e3b4ff34e8cda8ee3b1b68cc963786883'
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/postgres" &&
   -x "$PG_BIN/pg_controldata" && -x "$PG_BIN/psql" ]] || refuse 'PostgreSQL server tools unavailable'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'Expected PostgreSQL 16'
for script in "$OFFLINE" "$VERIFY" "$BACKUP_SCRIPT"; do
  [[ -f "$script" && ! -L "$script" ]] || refuse 'Reviewed prerequisite script missing or linked'
done
[[ "$(sha256sum "$OFFLINE" | cut -d' ' -f1)" == "$OFFLINE_SHA" ]] || refuse 'Offline inspector source changed'
[[ "$(sha256sum "$VERIFY" | cut -d' ' -f1)" == "$VERIFY_SHA" ]] || refuse 'Read-only audit source changed'
[[ "$(sha256sum "$BACKUP_SCRIPT" | cut -d' ' -f1)" == "$BACKUP_SCRIPT_SHA" ]] || refuse 'Retained backup verifier source changed'
{ sudo -u postgres test ! -e "$SOURCE_BASE/.pulse-5u2-ready" && sudo -u postgres test ! -L "$SOURCE_BASE/.pulse-5u2-ready"; } || refuse 'Source is no longer quarantined'

echo '========== VERIFY ORIGINAL CLUSTER AND RETAINED BACKUP =========='
bash "$BACKUP_SCRIPT" --verify

if [[ "$MODE" == '--plan' ]]; then
  echo '========== D15C-5U-2F2C RETAINED SNAPSHOT RESTORE-TEST PLAN =========='
  echo "Protected stopped cluster: $SOURCE_BASE/data (NEVER started or changed)"
  echo "Read-only retained backup: $BACKUP_DATA (NEVER started or changed)"
  echo 'Create a fresh, owner-only PostgreSQL restore TEST COPY under /tmp'
  echo 'Compare every copied file to the pinned retained backup snapshot digest'
  echo 'Run only the temporary copy via a private Unix socket, port 55435, TCP off'
  echo 'Audit migrations, FORCE RLS, roles, credentials denial and zero operational rows'
  echo 'Stop/restart the temporary restore and compare migration receipt fingerprints'
  echo 'Remove only a verified cleanly stopped temporary restore; reverify retained backup'
  echo 'No retained backup deletion, no production approval, no offsite copy or PITR'
  echo 'NO SERVER STARTED BY PLAN | PUBLIC LAUNCH: NO_GO'
  exit 0
fi

RESTORE_BASE=''
RESTORE_DATA=''
RESTORE_SOCKET=''
RESTORE_STARTED=0
RESTORE_CLEANED=0

# The retained BACKUP data directory and temporary restore are postgres-owned 0700.
# The calling operator cannot safely test their children with Bash -d/-e/-f.
# Evaluate all private-path properties as postgres, retaining the same strict
# symlink and absence guards rather than broadening filesystem permissions.
postgres_directory_is_unlinked() {
  sudo -u postgres test -d "$1" && sudo -u postgres test ! -L "$1"
}

postgres_file_is_unlinked() {
  sudo -u postgres test -f "$1" && sudo -u postgres test ! -L "$1"
}

postgres_path_is_absent() {
  sudo -u postgres test ! -e "$1" && sudo -u postgres test ! -L "$1"
}

restore_path_valid() {
  [[ "$RESTORE_BASE" =~ ^/tmp/pulse-retained-restore-5u2-[A-Za-z0-9]{10}$ &&
     "$RESTORE_DATA" == "$RESTORE_BASE/data" &&
     "$RESTORE_SOCKET" == "$RESTORE_BASE/socket" ]] || return 1
  postgres_directory_is_unlinked "$RESTORE_BASE" &&
    postgres_file_is_unlinked "$RESTORE_BASE/.pulse-5u2f2c-restore-marker" &&
    [[ "$(sudo -u postgres stat -c '%U:%a' "$RESTORE_BASE")" == 'postgres:700' &&
       "$(sudo -u postgres stat -c '%U:%a' "$RESTORE_BASE/.pulse-5u2f2c-restore-marker")" == 'postgres:600' ]]
}

restore_running() {
  [[ -n "$RESTORE_DATA" ]] &&
    postgres_directory_is_unlinked "$RESTORE_DATA" &&
    sudo -u postgres "$PG_BIN/pg_ctl" -D "$RESTORE_DATA" status >/dev/null 2>&1
}

stop_restored() {
  if restore_running; then
    sudo -u postgres "$PG_BIN/pg_ctl" -D "$RESTORE_DATA" -m fast -w stop >/dev/null || return 1
  fi
  if restore_running || ! postgres_path_is_absent "$RESTORE_DATA/postmaster.pid"; then
    return 1
  fi
  postgres_directory_is_unlinked "$RESTORE_DATA" || return 1
  local state
  state="$(sudo -u postgres "$PG_BIN/pg_controldata" "$RESTORE_DATA" |
    sed -n 's/^Database cluster state:[[:space:]]*//p')" || return 1
  [[ "$state" == 'shut down' ]]
}

remove_restored() {
  restore_path_valid || return 1
  # Refuse deleting anything until the exact isolated cluster is cleanly stopped.
  stop_restored || return 1
  sudo -u postgres rm -rf -- "$RESTORE_BASE" || return 1
  [[ ! -e "$RESTORE_BASE" && ! -L "$RESTORE_BASE" ]] || return 1
  RESTORE_CLEANED=1
  echo 'PASS: temporary restored test cluster removed after verified clean shutdown'
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$RESTORE_BASE" && "$RESTORE_CLEANED" == 0 ]]; then
    echo '========== MANDATORY RESTORE-SANDBOX CLEANUP =========='
    if ! remove_restored; then
      echo 'CRITICAL: temporary restored copy could not be safely removed; manual review required' >&2
      echo 'Do NOT delete or start the original persistent database or retained backup' >&2
      code=1
    fi
  fi
  if [[ -n "$RESTORE_BASE" ]]; then
    bash "$BACKUP_SCRIPT" --verify || code=1
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Retained cold snapshot: never start/alter backup; refuse linked tablespaces.
postgres_directory_is_unlinked "$BACKUP_DATA" || refuse 'Retained backup data directory inaccessible or linked to postgres'
postgres_directory_is_unlinked "$BACKUP_DATA/pg_tblspc" || refuse 'Tablespace directory missing or linked (postgres-verified)'
postgres_directory_is_unlinked "$BACKUP_DATA/pg_wal" || refuse 'WAL directory is linked or absent (postgres-verified)'
EXTRA_TABLESPACES="$(sudo -u postgres find "$BACKUP_DATA/pg_tblspc" -mindepth 1 -maxdepth 1 -print -quit)"
[[ -z "$EXTRA_TABLESPACES" ]] || refuse 'External tablespaces are unsupported by this cold backup rehearsal'
UNSAFE_ENTRY="$(sudo -u postgres find "$BACKUP_DATA" ! -type f ! -type d -print -quit)"
[[ -z "$UNSAFE_ENTRY" ]] || refuse 'Backup data directory contains non-regular file or link'
BACKUP_BYTES="$(sudo -u postgres du -sb -- "$BACKUP_DATA" | awk '{print $1}')"
[[ "$BACKUP_BYTES" =~ ^[0-9]+$ && "$BACKUP_BYTES" -gt 0 && "$BACKUP_BYTES" -le 1073741824 ]] || refuse 'Backup exceeds the 1 GiB safety ceiling'
AVAILABLE="$(df -B1 --output=avail /tmp | tail -n 1 | tr -d '[:space:]')"
[[ "$AVAILABLE" =~ ^[0-9]+$ && "$AVAILABLE" -ge $((BACKUP_BYTES * 3)) ]] || refuse 'Insufficient temporary restore space'

# Root path is created as postgres with mode 0700; no users can read its data.
RESTORE_BASE="$(sudo -u postgres mktemp -d /tmp/pulse-retained-restore-5u2-XXXXXXXXXX)"
[[ "$RESTORE_BASE" =~ ^/tmp/pulse-retained-restore-5u2-[A-Za-z0-9]{10}$ ]] || refuse 'Unexpected restore path'
RESTORE_DATA="$RESTORE_BASE/data"
RESTORE_SOCKET="$RESTORE_BASE/socket"
sudo -u postgres touch "$RESTORE_BASE/.pulse-5u2f2c-restore-marker"
sudo -u postgres chmod 0600 "$RESTORE_BASE/.pulse-5u2f2c-restore-marker"
restore_path_valid || refuse 'Temporary restore directory identity mismatch'
sudo -u postgres mkdir -m 0700 "$RESTORE_SOCKET"

echo '========== COPY VERIFIED RETAINED BACKUP INTO TEMPORARY SANDBOX =========='
sudo -u postgres cp -a --reflink=never -- "$BACKUP_DATA" "$RESTORE_DATA"
[[ "$(sudo -u postgres stat -c '%U:%a' "$RESTORE_DATA")" == 'postgres:700' ]] || refuse 'Restored data directory is not owner-only'
# Verify neither source nor clone was started during copying.
bash "$BACKUP_SCRIPT" --verify
BACKUP_SHA="$(sudo -u postgres bash -c '
  set -euo pipefail
  cd "$1"
  find . -type f -print0 | LC_ALL=C sort -z |
    xargs -0 -r sha256sum -b -- | sha256sum | cut -d" " -f1
' _ "$BACKUP_DATA")"
RESTORE_SHA="$(sudo -u postgres bash -c '
  set -euo pipefail
  cd "$1"
  find . -type f -print0 | LC_ALL=C sort -z |
    xargs -0 -r sha256sum -b -- | sha256sum | cut -d" " -f1
' _ "$RESTORE_DATA")"
[[ "$BACKUP_SHA" =~ ^[0-9a-f]{64}$ && "$BACKUP_SHA" == "$RESTORE_SHA" ]] || refuse 'Retained snapshot restore copy SHA-256 mismatch'
# Verify this exact retained snapshot's known identity before running any server.
[[ "$BACKUP_SHA" == 'e1348fcee176ff546ae08792379a381329445d982ad40d8bef411839661b3106' ]] || refuse 'Retained snapshot identity differs from independently observed digest'
[[ "$(sudo -u postgres cat "$BACKUP_BASE/snapshot.meta")" == *"file_digest_sha256=$BACKUP_SHA"* ]] || refuse 'Retained snapshot manifest identity mismatch'
echo 'PASS: temporary restored physical files match retained backup byte-for-byte'

psql_restored() {
  local database="$1"
  shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -U postgres -d "$database" "$@"
}

start_restored() {
  postgres_path_is_absent "$RESTORE_DATA/postmaster.pid" || refuse 'Restored PostgreSQL PID file unexpectedly exists or is inaccessible'
  RESTORE_STARTED=1
  # These command-line settings override the restored copy's original settings;
  # its original Unix socket and port are NEVER used.
  sudo -u postgres "$PG_BIN/pg_ctl" -D "$RESTORE_DATA" -l "$RESTORE_BASE/server.log" \
    -o "-c listen_addresses= -c unix_socket_directories=$RESTORE_SOCKET -c port=$RESTORE_PORT -c ssl=off" \
    -w start >/dev/null
  local identity
  identity="$(psql_restored postgres -Atq -c "
    BEGIN READ ONLY;
    SELECT current_database() || '|' || current_user || '|' ||
       current_setting('data_directory') || '|' ||
       current_setting('unix_socket_directories') || '|' ||
       current_setting('port') || '|' ||
       (current_setting('listen_addresses')='')::text || '|' ||
       (inet_server_addr() IS NULL)::text || '|' ||
       (inet_server_port() IS NULL)::text;
    COMMIT;
  ")" || refuse 'Restored database identity query failed'
  [[ "$identity" == "postgres|postgres|$RESTORE_DATA|$RESTORE_SOCKET|$RESTORE_PORT|true|true|true" ]] || refuse 'Restored database escaped its dedicated socket or target'
  echo 'PASS: temporary restored copy only; TCP disabled and socket identity verified'
}

verify_restored_sql() {
  psql_restored pulse_metrics <<'SQL'
BEGIN READ ONLY;
DO $check$
DECLARE v_function oid;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR current_setting('transaction_read_only') <> 'on'
     OR current_setting('port') <> '55435'
     OR current_setting('listen_addresses') <> ''
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
  THEN RAISE EXCEPTION 'Restore SQL target or read-only mode invalid'; END IF;
  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps WHERE recorded_mode='fresh_replay') <> 6
     OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0002')
  THEN RAISE EXCEPTION 'Restore migration receipts incomplete'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('pulse_metrics_app','pulse_metrics_migrator')
       AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit))
     OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
     OR has_schema_privilege('pulse_metrics_app','pulse_security_migrations','USAGE')
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_agent_quota','USAGE')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_quota.network_buckets','SELECT')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_agent_quota.agent_buckets','SELECT')
  THEN RAISE EXCEPTION 'Restore role or runtime privilege regression'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND
      (n.nspname IN ('pulse_security_migrations','pulse_agent_enrollment',
        'pulse_telemetry_ingestion','pulse_telemetry_quota','pulse_telemetry_agent_quota')
       OR (n.nspname='public' AND c.relname IN ('agent_credentials','monitored_agents','telemetry_samples')))
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  ) THEN RAISE EXCEPTION 'Restore FORCE RLS missing'; END IF;
  v_function := to_regprocedure('pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)');
  IF v_function IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=v_function AND p.prosecdef
      AND p.proowner='pulse_metrics_telemetry_executor'::regrole
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN RAISE EXCEPTION 'Restore ingestion function insecure'; END IF;
  IF (SELECT count(*) FROM public.users) <> 0
     OR (SELECT count(*) FROM public.organizations) <> 0
     OR (SELECT count(*) FROM public.monitored_agents) <> 0
     OR (SELECT count(*) FROM public.agent_credentials) <> 0
     OR (SELECT count(*) FROM public.telemetry_samples) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_quota.network_buckets) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets) <> 0
  THEN RAISE EXCEPTION 'Restore unexpected operational records'; END IF;
  RAISE NOTICE 'PASS: restored receipts, function ownership, FORCE RLS, runtime ACL and zero operational data';
END;
$check$;
COMMIT;
SQL
  psql_restored pulse_metrics -q < scripts/migrations/ledger-audit.sql
  psql_restored pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql
  # Exercise permission denial with the effective restricted database role.
  local denial
  if denial="$(psql_restored pulse_metrics -v VERBOSITY=verbose -c \
      'SET ROLE pulse_metrics_app; SELECT count(*) FROM public.agent_credentials;' 2>&1)"; then
    refuse 'Restored ordinary app role unexpectedly read credentials'
  fi
  [[ "$denial" == *'42501:'* ]] || refuse 'Restricted read failed for an unexpected reason'
  echo 'PASS: restored runtime denied direct credential table access'
}

restore_receipt_fingerprint() {
  psql_restored pulse_metrics -Atq -c "
    BEGIN READ ONLY;
    SELECT encode(sha256(convert_to(jsonb_build_object(
      'drizzle', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.__drizzle_migrations x),
      'privileged', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version) FROM pulse_security_migrations.applied_privileged_steps x),
      'enrollment', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version) FROM pulse_agent_enrollment.schema_migrations x),
      'ingestion', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version) FROM pulse_telemetry_ingestion.schema_migrations x),
      'network', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version) FROM pulse_telemetry_quota.schema_migrations x),
      'agent', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.version) FROM pulse_telemetry_agent_quota.schema_migrations x)
    )::text, 'UTF8')), 'hex');
    COMMIT;
  "
}

FIRST_FINGERPRINT=''
for cycle in 1 2; do
  echo "========== RESTORED DATABASE START AND SECURITY AUDIT $cycle/2 =========="
  start_restored
  verify_restored_sql
  fingerprint="$(restore_receipt_fingerprint)" || refuse 'Cannot inspect restored migration receipts'
  [[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] || refuse 'Restored migration receipt fingerprint invalid'
  if [[ "$cycle" == 1 ]]; then
    FIRST_FINGERPRINT="$fingerprint"
  else
    [[ "$FIRST_FINGERPRINT" == "$fingerprint" ]] || refuse 'Restored receipt history changed across restart'
    echo 'PASS: restored migration receipt history survived restart without changes'
  fi
  stop_restored || refuse 'Restored PostgreSQL did not shut down cleanly'
  RESTORE_STARTED=0
  bash "$BACKUP_SCRIPT" --verify
done

echo '========== REMOVE ONLY VERIFIED TEMPORARY RESTORE =========='
remove_restored || refuse 'Restore sandbox could not be safely cleaned'
bash "$BACKUP_SCRIPT" --verify
echo '========== D15C-5U-2F2C RETAINED BACKUP RESTORE TEST: PASS =========='
echo 'PASS: retained-source byte-verified copy, two isolated restore starts and security audits'
echo 'PASS: temporary restored copy removed; retained backup and original cluster remained untouched'
echo 'RETAINED BACKUP PRESERVED | NO OFFSITE COPY | NO PITR | NO CUSTOMER DATA | PUBLIC LAUNCH: NO_GO'
