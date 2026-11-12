#!/usr/bin/env bash
# Phase 2E3C5D2: TWO distinct disposable PostgreSQL clusters, one offline
# before restoration into the other. This is NOT a production restore tool.
# NO DDL, dumps or user rows from the existing development database.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT || true
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -f .env ]] || fail 'Missing reviewed local .env development guard'
for bin in node sudo psql pg_config sha256sum mktemp git python3 cmp dd diff; do
  command -v "$bin" >/dev/null || fail "Prerequisite missing: $bin"
done
node --env-file=.env --input-type=module <<'NODE'
const url = process.env.DATABASE_URL;
if (!url || process.env.NODE_ENV === 'production') throw Error('Refusing production or missing local database');
const u = new URL(url);
if (!['postgres:','postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(u.username) !== 'pulse_metrics_app') {
  throw Error('Refusing nonlocal or elevated application connection');
}
console.log('PASS: local development runtime guard');
NODE
node scripts/migrations/verify-manifest.mjs
bash scripts/migrations/audit-adoption-drift.sh   # Strictly read-only on local baseline.
BASELINE='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
MAIN_VERSION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics \
  -c "SELECT current_setting('server_version_num')")" || fail 'Local baseline version lookup failed'
[[ "$MAIN_VERSION" =~ ^[0-9]{5,6}$ ]] || fail 'Unexpected PostgreSQL version string'
MAIN_MAJOR="$((MAIN_VERSION / 10000))"
PG_BIN="$(pg_config --bindir)"
if [[ -x "/usr/lib/postgresql/$MAIN_MAJOR/bin/initdb" ]]; then
  PG_BIN="/usr/lib/postgresql/$MAIN_MAJOR/bin"
fi
for exe in initdb postgres pg_ctl psql pg_dump pg_dumpall pg_restore createdb; do
  [[ -x "$PG_BIN/$exe" ]] || fail "Missing matched PostgreSQL binary $PG_BIN/$exe"
done
VERSION_TEXT="$("$PG_BIN/postgres" --version)"
if [[ "$VERSION_TEXT" =~ PostgreSQL\)?[[:space:]]+([0-9]+)([.]|$) ]]; then
  [[ "${BASH_REMATCH[1]}" == "$MAIN_MAJOR" ]] || fail 'PostgreSQL major mismatch'
else
  fail 'Unable to parse postgres server version'
fi
[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Unsupported operating-system user'
[[ "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Unsupported operating-system group'
SRC_PORT=55432
DST_PORT=55433
SRC_BASE=''; DST_BASE=''; SCRATCH=''
SRC_DATA=''; DST_DATA=''; SRC_SOCKET=''; DST_SOCKET=''
SRC_STARTED=0; DST_STARTED=0
cleanup() {
  local status=$? i base data started marker stopped
  trap - EXIT
  set +e
  for i in DST SRC; do
    if [[ "$i" == DST ]]; then
      base="$DST_BASE"; data="$DST_DATA"; started="$DST_STARTED"; marker='.pulse-recovery-target'
    else
      base="$SRC_BASE"; data="$SRC_DATA"; started="$SRC_STARTED"; marker='.pulse-recovery-source'
    fi
    if [[ -n "$base" &&
          ( ( "$i" == SRC && "$base" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ) ||
            ( "$i" == DST && "$base" =~ ^/tmp/pulse-fullrecovery-[A-Za-z0-9]{10}$ ) ) ]] &&
       sudo -u postgres test -f "$base/$marker"; then
      stopped=1
      if [[ "$started" -eq 1 ]]; then
        sudo -u postgres "$PG_BIN/pg_ctl" -D "$data" -m fast -w stop >/dev/null 2>&1 ||
          sudo -u postgres "$PG_BIN/pg_ctl" -D "$data" -m immediate -w stop >/dev/null 2>&1 || stopped=0
      fi
      if [[ "$stopped" -eq 1 ]] &&
         ! sudo -u postgres "$PG_BIN/pg_ctl" -D "$data" status >/dev/null 2>&1; then
        sudo -u postgres rm -rf -- "$base" || stopped=0
      else
        stopped=0
      fi
      if [[ "$stopped" -eq 0 ]]; then
        printf 'CRITICAL: temporary %s cluster retained for manual inspection: %s\n' "$i" "$base" >&2
        status=1
      else
        printf 'PASS: removed independently isolated %s cluster and its synthetic artifacts\n' "$i"
      fi
    fi
  done
  if [[ -n "$SCRATCH" && "$SCRATCH" =~ ^/tmp/pulse-fullrecovery-check-[A-Za-z0-9]{8}$ ]]; then
    rm -rf -- "$SCRATCH" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
SCRATCH="$(mktemp -d /tmp/pulse-fullrecovery-check-XXXXXXXX)"
chmod 0700 "$SCRATCH"
SRC_BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
DST_BASE="$(sudo -u postgres mktemp -d /tmp/pulse-fullrecovery-XXXXXXXXXX)"
[[ "$SRC_BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ &&
   "$DST_BASE" =~ ^/tmp/pulse-fullrecovery-[A-Za-z0-9]{10}$ &&
   "$SRC_BASE" != "$DST_BASE" ]] || fail 'Unexpected or identical temporary cluster locations'
SRC_DATA="$SRC_BASE/data"; SRC_SOCKET="$SRC_BASE/socket"
DST_DATA="$DST_BASE/data"; DST_SOCKET="$DST_BASE/socket"
# Enforce private directory permissions; postgres owns both disposable trees.
# Place cleanup markers before later setup commands can fail.
sudo -u postgres touch "$SRC_BASE/.pulse-recovery-source"
sudo -u postgres touch "$DST_BASE/.pulse-recovery-target"
for entry in "$SRC_BASE" "$DST_BASE"; do
  sudo -u postgres mkdir -m 0700 "$entry/data"
  sudo -u postgres mkdir -m 0755 "$entry/socket"
  sudo chgrp "$(id -gn)" "$entry" "$entry/socket"
  sudo -u postgres chmod 0750 "$entry" "$entry/socket"
done

configure_cluster() {
  local data="$1" socket="$2" port="$3" bootstrap="$4"
  sudo -u postgres "$PG_BIN/initdb" -D "$data" --username="$bootstrap" \
    --auth-local=peer --auth-host=reject --no-instructions >/dev/null
  sudo -u postgres tee "$data/pg_ident.conf" >/dev/null <<IDENT
pulse_fullrecovery $(id -un) pulse_metrics_migrator
pulse_fullrecovery $(id -un) pulse_metrics_app
pulse_fullrecovery_bootstrap postgres pulse_recovery_bootstrap
IDENT
  sudo -u postgres tee "$data/pg_hba.conf" >/dev/null <<'HBA'
local all pulse_recovery_bootstrap peer map=pulse_fullrecovery_bootstrap
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_fullrecovery
local pulse_metrics pulse_metrics_app peer map=pulse_fullrecovery
local all all reject
host all all 0.0.0.0/0 reject
host all all ::/0 reject
HBA
  sudo -u postgres tee -a "$data/postgresql.conf" >/dev/null <<CONFIG
listen_addresses = ''
port = $port
unix_socket_directories = '$socket'
unix_socket_permissions = 0777
logging_collector = off
CONFIG
}
psql_source() {
  local db="$1"; shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SRC_SOCKET" -p "$SRC_PORT" -U postgres -d "$db" "$@"
}
psql_target() {
  local db="$1"; shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$DST_SOCKET" -p "$DST_PORT" -U postgres -d "$db" "$@"
}
verify_socket() {
  local socket="$1" port="$2" db_user="$3" data="$4" expected_database="$5"
  local observed
  observed="$(sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At \
    -h "$socket" -p "$port" -U "$db_user" -d "$expected_database" -c \
    "SELECT current_setting('data_directory') || '|' || current_user || '|' || current_database() || '|' || (inet_server_addr() IS NULL)::text || '|' || (current_setting('listen_addresses')='')::text")" || return 1
  [[ "$observed" == "$data|$db_user|$expected_database|true|true" ]]
}

echo '========== CREATE ISOLATED SOURCE CLUSTER =========='
configure_cluster "$SRC_DATA" "$SRC_SOCKET" "$SRC_PORT" postgres
SRC_STARTED=1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$SRC_DATA" -l "$SRC_BASE/start.log" -w start >/dev/null
verify_socket "$SRC_SOCKET" "$SRC_PORT" postgres "$SRC_DATA" postgres ||
  fail 'Source cluster identity/socket not proven isolated'
echo 'PASS: source data directory, unix-only socket, and postgres identity verified'

# Original role, database and migration source; real Drizzle ledger.
psql_source postgres -q < scripts/replay/bootstrap-roles.sql
sudo -u postgres "$PG_BIN/createdb" -h "$SRC_SOCKET" -p "$SRC_PORT" \
  -U postgres -O postgres pulse_metrics
psql_source pulse_metrics -q < scripts/replay/bootstrap-database.sql
PULSE_REPLAY_SOCKET="$SRC_SOCKET" PULSE_REPLAY_DATA="$SRC_DATA" PULSE_REPLAY_PORT="$SRC_PORT" \
  node scripts/replay/migrate-isolated.mjs
psql_source pulse_metrics -q < scripts/replay/runtime-grants.sql
psql_source pulse_metrics -q < scripts/migrations/ledger-bootstrap.sql
MANIFEST_STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)" || fail 'Cannot verify immutable migrations'
[[ "$(printf '%s\n' "$MANIFEST_STEPS" | wc -l)" -eq 6 ]] || fail 'Expected six immutable privileged migration sources'
while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ && "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ &&
     "$source" == scripts/admin/${version}_* && "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'Unrecognized administrator migration source'
  { printf 'BEGIN READ ONLY;\n';
    printf "SELECT set_config('pulse.replay_step_version','%s',true);\n" "$version"
    cat scripts/migrations/step-preflight-assert.sql
    printf 'COMMIT;\n';
  } | psql_source pulse_metrics -q >/dev/null
  psql_source pulse_metrics -q < "$source"
  psql_source pulse_metrics -q -v "version=$version" -v "source_path=$source" \
    -v "digest=$digest" < scripts/migrations/ledger-record.sql
  echo "RECORDED original privileged step $version in disposable SOURCE only"
done <<< "$MANIFEST_STEPS"
psql_source pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_source pulse_metrics -q < scripts/audit/migration-security-invariants.sql
psql_source pulse_metrics -q < scripts/recovery/create-synthetic-fixture.sql >/dev/null
psql_source pulse_metrics -Atq < scripts/recovery/fixture-fingerprint.sql > "$SCRATCH/rows-source.txt"
psql_source pulse_metrics -Atq < scripts/replay/catalog-manifest.sql > "$SCRATCH/catalog-source.txt"
psql_source pulse_metrics -Atq < scripts/recovery/global-inventory.sql > "$SCRATCH/globals-source.txt"
[[ "$(sha256sum "$SCRATCH/catalog-source.txt" | cut -d' ' -f1)" == "$BASELINE" ]] ||
  fail 'Source schema does not match original security baseline'
[[ "$(grep -Ec '^[0-9a-f]{64}$' "$SCRATCH/rows-source.txt")" -eq 1 ]] ||
  fail 'Source synthetic data hash missing'
[[ "$(grep -Ec '^role\|' "$SCRATCH/globals-source.txt")" -ge 9 ]] ||
  fail 'Expected postgres, migrator, app, and six privileged function owner roles'
echo 'PASS: source synthetic data and role/schema security state captured'

# Both artifacts are derived ONLY from the source disposable cluster.
echo '========== BACK UP DATABASE AND CLUSTER GLOBALS =========='
DB_DUMP="$SRC_BASE/only-synthetic-db.dump"
GLOBALS="$SRC_BASE/only-synthetic-globals.sql"
sudo -u postgres "$PG_BIN/pg_dump" -Fc --no-password -h "$SRC_SOCKET" -p "$SRC_PORT" \
  -U postgres -f "$DB_DUMP" pulse_metrics
sudo -u postgres "$PG_BIN/pg_dumpall" --globals-only --no-role-passwords \
  --no-password -h "$SRC_SOCKET" -p "$SRC_PORT" -U postgres \
  -f "$GLOBALS"
sudo -u postgres chmod 0600 "$DB_DUMP" "$GLOBALS"
sudo -u postgres "$PG_BIN/pg_restore" --list "$DB_DUMP" > "$SCRATCH/toc.txt"
for object in 'TABLE DATA public users' 'TABLE DATA public telemetry_samples' \
              'TABLE DATA pulse_security_migrations applied_privileged_steps'; do
  grep -Fq "$object" "$SCRATCH/toc.txt" || fail "Database archive missing required object: $object"
done
[[ "$(sudo -u postgres stat -c %s "$GLOBALS")" -gt 100 ]] || fail 'Global SQL archive unexpectedly small'
SRC_DB_HASH="$(sudo -u postgres sha256sum "$DB_DUMP" | cut -d' ' -f1)"
SRC_GLOBAL_HASH="$(sudo -u postgres sha256sum "$GLOBALS" | cut -d' ' -f1)"
echo 'PASS: custom-format synthetic database backup and separate global-role SQL created'

# A different bootstrap name allows pg_dumpall to create the 'postgres' role
# without the normal duplicate-superuser collision; no role is filtered out.
echo '========== INITIALIZE INDEPENDENT REPLACEMENT CLUSTER =========='
configure_cluster "$DST_DATA" "$DST_SOCKET" "$DST_PORT" pulse_recovery_bootstrap
DST_STARTED=1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DST_DATA" -l "$DST_BASE/start.log" -w start >/dev/null
verify_socket "$DST_SOCKET" "$DST_PORT" pulse_recovery_bootstrap "$DST_DATA" postgres ||
  fail 'Replacement cluster identity/socket not proven isolated'
# Verify expected source roles do NOT exist in independent replacement.
MISSING="$(sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At \
  -h "$DST_SOCKET" -p "$DST_PORT" -U pulse_recovery_bootstrap -d postgres \
  -c "SELECT (to_regrole('postgres') IS NULL AND to_regrole('pulse_metrics_app') IS NULL AND to_regrole('pulse_metrics_migrator') IS NULL)::text")"
[[ "$MISSING" == true ]] || fail 'Replacement already contains original roles; global restore not independently exercised'
echo 'PASS: replacement has distinct data directory and no source roles'

# Copy to target-owned private storage; assert exact transfer hashes.
DST_DB="$DST_BASE/restore-synthetic-db.dump"
DST_GLOBALS="$DST_BASE/restore-synthetic-globals.sql"
sudo -u postgres cp -- "$DB_DUMP" "$DST_DB"
sudo -u postgres cp -- "$GLOBALS" "$DST_GLOBALS"
sudo -u postgres chmod 0600 "$DST_DB" "$DST_GLOBALS"
[[ "$(sudo -u postgres sha256sum "$DST_DB" | cut -d' ' -f1)" == "$SRC_DB_HASH" &&
   "$(sudo -u postgres sha256sum "$DST_GLOBALS" | cut -d' ' -f1)" == "$SRC_GLOBAL_HASH" ]] ||
  fail 'Backup transfer hash mismatch; refusing recovery'
# Deliberately truncated archive must be rejected BEFORE it is restored.
sudo -u postgres dd if="$DST_DB" of="$DST_BASE/corrupt-only-test.dump" bs=16 count=1 status=none
if sudo -u postgres "$PG_BIN/pg_restore" --list "$DST_BASE/corrupt-only-test.dump" \
  > "$SCRATCH/corrupt.log" 2>&1; then
  fail 'Truncated archive unexpectedly accepted by pg_restore'
fi
echo 'PASS: simulated truncated backup artifact rejected'

# OFFLINE SOURCE before ANY replacement writes. Exact source pg_ctl proof.
sudo -u postgres "$PG_BIN/pg_ctl" -D "$SRC_DATA" -m fast -w stop >/dev/null
SRC_STARTED=0
if sudo -u postgres "$PG_BIN/pg_ctl" -D "$SRC_DATA" status >/dev/null 2>&1; then
  fail 'Source cluster unexpectedly still running'
fi
echo 'PASS: original disposable source cluster shut down prior to replacement restore'

echo '========== RESTORE CLUSTER GLOBALS IN REPLACEMENT =========='
# The target connection is ALWAYS to its unique Unix socket. The raw source
# global SQL is restored unchanged, with ON_ERROR_STOP (never ignore errors).
sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q \
  -h "$DST_SOCKET" -p "$DST_PORT" -U pulse_recovery_bootstrap -d postgres \
  -f "$DST_GLOBALS" > "$SCRATCH/global-restore.log"
verify_socket "$DST_SOCKET" "$DST_PORT" postgres "$DST_DATA" postgres ||
  fail 'Restored postgres role not usable in replacement'
echo 'PASS: global-role restore completed without skipped or conflicting statements'

# pg_restore -C creates the backed-up database and restores database-level
# grants/settings as well as owned objects. It cannot run as one global SQL
# transaction because CREATE DATABASE is not transactional. On ANY failure,
# refuse the result and destroy the entire isolated replacement cluster.
echo '========== RESTORE DATABASE INTO INDEPENDENT CLUSTER =========='
sudo -u postgres "$PG_BIN/pg_restore" --create --exit-on-error --no-password \
  -h "$DST_SOCKET" -p "$DST_PORT" -U pulse_recovery_bootstrap -d postgres \
  "$DST_DB" > "$SCRATCH/db-restore.log"
verify_socket "$DST_SOCKET" "$DST_PORT" postgres "$DST_DATA" pulse_metrics ||
  fail 'Restored target database not connected to correct independent cluster'
echo 'PASS: database archive restored into newly created database on replacement cluster'

psql_target pulse_metrics -q < scripts/recovery/recovered-state-audit.sql
psql_target pulse_metrics -q < scripts/audit/migration-security-invariants.sql
psql_target pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_target pulse_metrics -Atq < scripts/recovery/fixture-fingerprint.sql > "$SCRATCH/rows-target.txt"
psql_target pulse_metrics -Atq < scripts/replay/catalog-manifest.sql > "$SCRATCH/catalog-target.txt"
psql_target pulse_metrics -Atq < scripts/recovery/global-inventory.sql > "$SCRATCH/globals-target.txt"
cmp -s "$SCRATCH/rows-source.txt" "$SCRATCH/rows-target.txt" ||
  fail 'Synthetic application/ledger data or sequence state changed during full-cluster recovery'
python3 scripts/recovery/verify-restored-catalog.py \
  "$SCRATCH/catalog-source.txt" "$SCRATCH/catalog-target.txt" ||
  fail 'Recovered public security schema differs beyond reviewed deparse differences'
if ! cmp -s "$SCRATCH/globals-source.txt" "$SCRATCH/globals-target.txt"; then
  echo '========== CLUSTER ROLE AND DATABASE-LEVEL DIFFERENCES ==========' >&2
  diff -u "$SCRATCH/globals-source.txt" "$SCRATCH/globals-target.txt" | head -100 >&2 || true
  fail 'PostgreSQL role/privilege/database-level inventory differs after restore'
fi
echo 'PASS: independent replacement has matching roles, memberships, database grants and role settings'
echo 'PASS: synthetic rows, telemetry sequence, migration receipts and security catalog preserved'

RUNTIME_INFO="$("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At \
  -h "$DST_SOCKET" -p "$DST_PORT" -U pulse_metrics_app -d pulse_metrics \
  -c "SELECT current_user || '|' || current_database() || '|' || (inet_server_addr() IS NULL)::text")" ||
  fail 'Runtime role cannot connect to restored independent database'
[[ "$RUNTIME_INFO" == 'pulse_metrics_app|pulse_metrics|true' ]] ||
  fail 'Runtime identity/transport unexpectedly changed'
for query in \
  'SELECT * FROM public.agent_credentials LIMIT 1' \
  'SELECT * FROM public.invitation_rate_limits LIMIT 1' \
  'SELECT * FROM pulse_security_migrations.applied_privileged_steps LIMIT 1' \
  'CREATE TABLE public.illegal_recovery_probe(id integer)'; do
  if "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At -h "$DST_SOCKET" -p "$DST_PORT" \
       -U pulse_metrics_app -d pulse_metrics -c "$query" > /dev/null 2>&1; then
    fail 'Restricted application role gained forbidden access on replacement cluster'
  fi
done
echo 'PASS: replacement cluster app role denied private-table, receipt and DDL access'

# Re-audit local baseline using its default socket only, READ ONLY.
MAIN_AFTER="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)" ||
  fail 'Final baseline read-only inspection failed'
[[ "$MAIN_AFTER" == "$BASELINE" ]] || fail 'Working database catalog changed during rehearsal'
echo 'PASS: existing working database catalog unchanged'
echo '========== FULL-CLUSTER RECOVERY REHEARSAL COMPLETED =========='
echo 'PASS: globals + database recovered into independent Unix-only PostgreSQL cluster after source shutdown'
echo 'PASS: corrupted backup rejected, synthetic data intact, global roles and security restrictions preserved'
echo 'NOTE: target has an additional disposable bootstrap superuser excluded from inventory; this is not production provisioning.'
echo 'NOTE: no real data dumped, no real credentials restored, no PITR/WAL or production RPO/RTO claimed.'
