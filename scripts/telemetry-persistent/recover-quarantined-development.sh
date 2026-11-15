#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2D — exact-state, one-time persistent DEV schema recovery.
# This is NOT a generalized installer. Only the already inventoried 5U-2B3C
# cluster may be repaired. The original immutable migration sources stay intact.
# No production access, fixtures, API, agent, or ready marker is created.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2D: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 && ( "$1" == '--plan' || "$1" == '--apply' ) ]] || refuse 'Use exactly --plan or --apply'
MODE="$1"
[[ "$(uname -s)" == 'Linux' && "$(id -u)" -ne 0 ]] || refuse 'Non-root Linux operator required'
[[ "${NODE_ENV:-development}" != production && -z "${NODE_OPTIONS:-}" ]] || refuse 'Production/Node options refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited database URL refused'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
for bin in node sudo pg_config sha256sum git mktemp cp chmod stat; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing prerequisite: $bin"
done
# libpq must never be able to redirect an administrator connection.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA PGCONNECT_TIMEOUT || true

BASE='/var/lib/postgresql/pulse-metrics-dev-5u2'
DATA="$BASE/data"
SOCKET="$BASE/socket"
PORT=55433
OFFLINE='scripts/telemetry-dev/inspect-incomplete-persistent-development.sh'
SQL_INVENTORY='scripts/telemetry-dev/inspect-quarantined-persistent-sql.sh'
GENERATOR='scripts/telemetry-persistent/release-candidates.mjs'
EXPECTED_OFFLINE='7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'
EXPECTED_INVENTORY='927d160bbc384c75eecd518d67039deb57c239a53f0e69beac17d3aacac8412a'
EXPECTED_GENERATOR='6aea75c795dc1b314a39452adc2c7aef64ff6340af92af7342dc1c58d4e76ce7'
ORIGINAL_CATALOG='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/psql" && -x "$PG_BIN/postgres" ]] || refuse 'PostgreSQL binaries unavailable'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'Expected PostgreSQL 16'

verify_pinned_file() {
  local path="$1" expected="$2"
  [[ -f "$path" && ! -L "$path" ]] || refuse "Required reviewed source missing or linked: $path"
  [[ "$(stat -c %h "$path")" == 1 ]] || refuse "Reviewed source hardlinked: $path"
  [[ "$(sha256sum "$path" | cut -d' ' -f1)" == "$expected" ]] || refuse "Reviewed source changed: $path"
}
verify_pinned_file "$OFFLINE" "$EXPECTED_OFFLINE"
verify_pinned_file "$SQL_INVENTORY" "$EXPECTED_INVENTORY"
verify_pinned_file "$GENERATOR" "$EXPECTED_GENERATOR"

# Candidate verifier re-generates ALL three complete SQL files from the three
# individually SHA-pinned originals, and byte-compares the candidate manifest.
# No database interaction occurs during this step.
echo '========== VERIFY ALL THREE DEVELOPMENT MIGRATION ARTIFACTS =========='
node "$GENERATOR" --verify

if ! git diff --quiet HEAD -- drizzle scripts/replay scripts/migrations \
    scripts/admin scripts/audit scripts/agent-enrollment \
    scripts/telemetry-ingestion scripts/telemetry-quota \
    scripts/telemetry-agent-quota scripts/telemetry-auth-outcome; then
  refuse 'Historical tracked migration inputs have changed'
fi

ENTRY_ROWS="$(node --input-type=module <<'NODE'
import { ROOT, buildCandidates, verifyOutputs } from './scripts/telemetry-persistent/release-candidates.mjs';
const items = verifyOutputs(ROOT, buildCandidates(ROOT));
if (items.length !== 3) throw new Error('Expected exactly three candidate files');
for (const { spec, targetHash } of items) {
  if (!/^[0-9a-f]{64}$/.test(targetHash)) throw new Error('Invalid candidate checksum');
  console.log(`${spec.target}\t${targetHash}`);
}
NODE
)" || refuse 'Could not verify source hashes'
mapfile -t ENTRIES <<< "$ENTRY_ROWS"
[[ "${#ENTRIES[@]}" -eq 3 ]] || refuse 'Expected exactly three candidate entries'
PATHS=(
  'scripts/telemetry-persistent/migrations/0001_network_quota_dev_candidate.sql'
  'scripts/telemetry-persistent/migrations/0002_agent_quota_dev_candidate.sql'
  'scripts/telemetry-persistent/migrations/0003_credential_outcome_dev_candidate.sql'
)
HASHES=()
for i in 0 1 2; do
  IFS=$'\t' read -r file digest unexpected <<< "${ENTRIES[i]}"
  [[ "$file" == "${PATHS[i]}" && "$digest" =~ ^[0-9a-f]{64}$ && -z "${unexpected:-}" ]] || refuse 'Candidate order, path or SHA unexpected'
  verify_pinned_file "$file" "$digest"
  HASHES+=("$digest")
done

# Offline inspector checks the real PostgreSQL base directory, permissions,
# clean shutdown, absence of READY marker, socket-only setup, and original DB.
echo '========== REVALIDATE STOPPED, QUARANTINED CLUSTER =========='
bash "$OFFLINE"
if [[ "$MODE" == '--plan' ]]; then
  echo '========== D15C-5U-2D GUARDED PARTIAL RECOVERY PLAN =========='
  echo 'Starting state must be Drizzle 1 / historical 6 / enrollment 1 / ingestion 1.'
  echo 'No quota/agent quota schemas; no organizations, agents, credentials, or telemetry.'
  for i in 0 1 2; do
    printf 'Reviewed SQL %s | SHA256 %s\n' "${PATHS[i]}" "${HASHES[i]}"
  done
  echo 'On --apply: re-verify exact database identity and partial SQL state before any write.'
  echo 'Apply ONLY these three SQL files, in order; check each receipt and runtime ACL.'
  echo 'If any SQL fails: STOP cluster, RETAIN partial state, forbid automated retry.'
  echo 'Success: STOP cluster, recheck original DB; NO READY MARKER OR AGENT ACTIVATION.'
  echo 'NO DATABASE STARTED | NO SQL CHANGED | PUBLIC LAUNCH: NO_GO'
  exit 0
fi

[[ "${PULSE_APPROVE_5U2D_PARTIAL_RELEASE:-}" == 'THREE_MIGRATIONS_ONLY' ]] || refuse 'Explicit THREE_MIGRATIONS_ONLY approval required'
[[ ! -e "$BASE/.pulse-5u2-ready" && ! -L "$BASE/.pulse-5u2-ready" ]] || refuse 'Readiness marker present: refuse recovery'

START_ATTEMPTED=0
SUCCESS=0
TMP_SQL=''
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$TMP_SQL" && -f "$TMP_SQL" ]]; then rm -f -- "$TMP_SQL"; fi
  if (( START_ATTEMPTED )); then
    echo '========== MANDATORY POSTGRESQL SHUTDOWN =========='
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop || exit_code=1
    fi
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      echo 'CRITICAL: persistent cluster still running' >&2
      exit_code=1
    else
      echo 'PASS: retained persistent cluster stopped'
      if ! bash "$OFFLINE"; then
        echo 'CRITICAL: final offline checks failed' >&2
        exit_code=1
      fi
    fi
  fi
  if (( ! SUCCESS )); then
    echo 'STOP: partial recovery is NOT complete; do not rerun --apply.' >&2
    echo 'Leave the cluster quarantined and inspect its SQL state.' >&2
  fi
  exit "$exit_code"
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

# The SQL inventory is an additional independent read-only audit prior to any
# write: it starts and stops the same cluster with its own mandatory trap.
echo '========== REPEAT INDEPENDENT READ-ONLY PARTIAL-STATE INVENTORY =========='
bash "$SQL_INVENTORY"
# Inventory's stop is checked again before we start our own controlled session.
bash "$OFFLINE"

echo '========== START EXACT QUARANTINED CLUSTER =========='
START_ATTEMPTED=1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/server.log" -w start >/dev/null

# Only local administrator may read protected PostgreSQL config parameters.
IDENTITY="$(psql_admin postgres -Atq -c "
  SELECT current_setting('data_directory') || '|' || current_user || '|' ||
         (inet_server_addr() IS NULL)::text || '|' ||
         (inet_server_port() IS NULL)::text || '|' ||
         (current_setting('listen_addresses') = '')::text || '|' ||
         current_setting('unix_socket_directories') || '|' || current_setting('port')")"
[[ "$IDENTITY" == "$DATA|postgres|true|true|true|$SOCKET|$PORT" ]] || refuse 'Administrator server identity mismatch'

echo '========== STRICT PARTIAL DATABASE PREFLIGHT (READ ONLY) =========='
psql_admin pulse_metrics <<'SQLPREFLIGHT'
BEGIN READ ONLY;
DO $preflight$
DECLARE v_hash text;
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL OR inet_server_port() IS NOT NULL
     OR current_setting('listen_addresses') <> ''
     OR current_setting('port') <> '55433'
     OR current_setting('data_directory') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
     OR current_setting('unix_socket_directories') <> '/var/lib/postgresql/pulse-metrics-dev-5u2/socket'
  THEN RAISE EXCEPTION 'REFUSE_5U2D: wrong database or connection'; END IF;

  IF to_regclass('public.__drizzle_migrations') IS NULL
     OR to_regclass('pulse_security_migrations.applied_privileged_steps') IS NULL
     OR to_regclass('pulse_agent_enrollment.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.schema_migrations') IS NULL
     OR to_regclass('pulse_telemetry_ingestion.submissions') IS NULL
     OR to_regclass('public.agent_credentials') IS NULL
     OR to_regclass('public.telemetry_samples') IS NULL
     OR to_regnamespace('pulse_telemetry_quota') IS NOT NULL
     OR to_regnamespace('pulse_telemetry_agent_quota') IS NOT NULL
     OR to_regrole('pulse_metrics_telemetry_quota_executor') IS NOT NULL
     OR to_regrole('pulse_metrics_telemetry_agent_quota_executor') IS NOT NULL
  THEN RAISE EXCEPTION 'REFUSE_5U2D: unexpected source schema'; END IF;

  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps) <> 6
     OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps WHERE recorded_mode='fresh_replay') <> 6
     OR (SELECT count(*) FROM pulse_agent_enrollment.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_agent_enrollment.schema_migrations WHERE version='0001')
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_ingestion.schema_migrations WHERE version='0001')
     OR (SELECT count(*) FROM public.organizations) <> 0
     OR (SELECT count(*) FROM public.users) <> 0
     OR (SELECT count(*) FROM public.monitored_agents) <> 0
     OR (SELECT count(*) FROM public.agent_credentials) <> 0
     OR (SELECT count(*) FROM public.agent_enrollment_tokens) <> 0
     OR (SELECT count(*) FROM public.telemetry_samples) <> 0
     OR (SELECT count(*) FROM public.audit_events) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 0
  THEN RAISE EXCEPTION 'REFUSE_5U2D: partial receipts or data differ'; END IF;

  IF (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'pulse_metrics%') <> 10
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('pulse_metrics_app','pulse_metrics_migrator')
                  AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit))
     OR has_schema_privilege('pulse_metrics_app','pulse_security_migrations','USAGE')
     OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
  THEN RAISE EXCEPTION 'REFUSE_5U2D: baseline role/ACL mismatch'; END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE (n.nspname='public' AND c.relname IN
                    ('agent_credentials','monitored_agents','telemetry_samples'))
                OR (n.nspname IN ('pulse_security_migrations','pulse_agent_enrollment',
                                  'pulse_telemetry_ingestion') AND c.relkind IN ('r','p'))
             GROUP BY c.oid HAVING NOT bool_and(c.relrowsecurity AND c.relforcerowsecurity))
  THEN RAISE EXCEPTION 'REFUSE_5U2D: RLS is not forced'; END IF;

  SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') INTO v_hash
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(
      'pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)')
      AND p.prosecdef
      AND p.proowner='pulse_metrics_telemetry_executor'::regrole
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[];
  IF v_hash IS DISTINCT FROM '588783991e63bc975f774692fc6732c80ac2e9070b33c93bea43c503e31f2f1f' THEN
    RAISE EXCEPTION 'REFUSE_5U2D: ingestion function body or owner differs from D15B';
  END IF;
  RAISE NOTICE 'PASS: exact durable partial state, restricted runtime and unchanged ingestion function';
END;
$preflight$;
COMMIT;
SQLPREFLIGHT

# Independent existing read-only audits must also pass. No receipts may be
# backfilled and no existing privileged SQL may be replayed.
echo '========== VERIFY EXISTING RECEIPTS AND SECURITY GATES =========='
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql

echo '========== APPLY ONLY THREE NEW DEVELOPMENT SQL MIGRATIONS =========='
for i in 0 1 2; do
  file="${PATHS[i]}"
  digest="${HASHES[i]}"
  # Independently re-generate/byte-compare before each migration and capture
  # exactly the verified SQL bytes. Never read from a mutable source stream.
  node "$GENERATOR" --verify
  verify_pinned_file "$file" "$digest"
  TMP_SQL="$(mktemp /tmp/pulse-5u2d-migration-XXXXXXXX.sql)"
  cp -- "$file" "$TMP_SQL"
  chmod 0600 "$TMP_SQL"
  [[ "$(sha256sum "$TMP_SQL" | cut -d' ' -f1)" == "$digest" ]] || refuse 'Captured SQL differs from pinned file'
  echo "APPLY: ${PATHS[i]} (verified SHA256 ${HASHES[i]})"
  psql_admin pulse_metrics -q < "$TMP_SQL"
  rm -f -- "$TMP_SQL"
  TMP_SQL=''
  case "$i" in
    0)
      psql_admin pulse_metrics -q <<'SQLNETWORK'
BEGIN READ ONLY;
DO $v$
BEGIN
  IF to_regclass('pulse_telemetry_quota.schema_migrations') IS NULL
     OR (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_quota.schema_migrations WHERE version='0001')
     OR to_regclass('pulse_telemetry_quota.network_buckets') IS NULL
     OR (SELECT count(*) FROM pulse_telemetry_quota.network_buckets) <> 0
     OR to_regnamespace('pulse_telemetry_agent_quota') IS NOT NULL
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_quota.network_buckets','SELECT')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_quota.network_buckets','UPDATE')
  THEN RAISE EXCEPTION 'REFUSE_5U2D: network quota postcondition failed'; END IF;
END;
$v$;
COMMIT;
SQLNETWORK
      ;;
    1)
      psql_admin pulse_metrics -q <<'SQLAGENT'
BEGIN READ ONLY;
DO $v$
BEGIN
  IF to_regclass('pulse_telemetry_agent_quota.schema_migrations') IS NULL
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0001')
     OR to_regclass('pulse_telemetry_agent_quota.agent_buckets') IS NULL
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets) <> 0
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_agent_quota','USAGE')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_agent_quota.agent_buckets','SELECT')
  THEN RAISE EXCEPTION 'REFUSE_5U2D: agent quota postcondition failed'; END IF;
END;
$v$;
COMMIT;
SQLAGENT
      ;;
    2)
      psql_admin pulse_metrics -q <<'SQLPATCH'
BEGIN READ ONLY;
DO $v$
BEGIN
  IF (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0002')
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_agent_quota','USAGE')
     OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR (SELECT count(*) FROM public.organizations) <> 0
     OR (SELECT count(*) FROM public.telemetry_samples) <> 0
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 0
  THEN RAISE EXCEPTION 'REFUSE_5U2D: credential outcome postcondition failed'; END IF;
  RAISE NOTICE 'PASS: 1 Drizzle, 6 privileged, 1 enrollment, 1 ingress, 1 network, 2 agent revisions; zero fixtures';
END;
$v$;
COMMIT;
SQLPATCH
      ;;
  esac
done

# Reuse the locked D15B security check after all function revisions.
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql

# Confirm the original DB catalog never changed (different socket/cluster).
ACTUAL="$(sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -Atq \
  -d pulse_metrics < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$ACTUAL" == "$ORIGINAL_CATALOG" ]] || refuse 'Original database security catalog changed'

# Finish the exact-state recovery by stopping PostgreSQL and checking the
# ordinary database fingerprint once more. The success marker is NOT created:
# this remains an intentionally quarantined development database.
echo '========== STOP AND REVERIFY CLUSTER BEFORE REPORTING SUCCESS =========='
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null
bash "$OFFLINE"
START_ATTEMPTED=0
SUCCESS=1
echo '========== D15C-5U-2D SCHEMA-ONLY RECOVERY: VERIFIED =========='
echo 'PASS: three versioned development candidates installed; no fixtures, no ready marker'
echo 'PASS: PostgreSQL stopped; original development database fingerprint unchanged'
echo 'QUARANTINED UNTIL BACKUP/RESTART/ISOLATION AUDITS | PUBLIC LAUNCH: NO_GO'
