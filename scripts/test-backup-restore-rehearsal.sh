#!/usr/bin/env bash
# Pulse Metrics Phase 2E3C5D1 — disposable PostgreSQL backup/restore rehearsal.
# Reviewed restoration deparse variants are checked with an exact allowlist.
# NEVER backs up, renames, drops, restores or writes the existing installation.
# A separate, marked, Unix-only PostgreSQL cluster is required for every write.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGCLUSTER PGPASSFILE || true
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -f .env ]] || fail 'Local development .env missing'
for exe in node sudo psql pg_config sha256sum mktemp cmp grep git python3; do
  command -v "$exe" >/dev/null || fail "Missing prerequisite: $exe"
done
node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw || process.env.NODE_ENV === 'production') throw Error('Refusing production or missing runtime connection');
const u = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(u.username) !== 'pulse_metrics_app') {
  throw Error('Refusing nonlocal/non-runtime database target');
}
console.log('PASS: local development guard');
NODE
node scripts/migrations/verify-manifest.mjs
# This earlier gate inspects the existing local database READ ONLY.
bash scripts/migrations/audit-adoption-drift.sh
BASELINE_HASH='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
MAIN_VERSION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics -c "SELECT current_setting('server_version_num')")" || fail 'Cannot inspect PostgreSQL version'
[[ "$MAIN_VERSION" =~ ^[0-9]{5,6}$ ]] || fail 'Invalid PostgreSQL version'
MAIN_MAJOR="$((MAIN_VERSION / 10000))"
PG_BIN="$(pg_config --bindir)"
if [[ -x "/usr/lib/postgresql/$MAIN_MAJOR/bin/initdb" ]]; then
  PG_BIN="/usr/lib/postgresql/$MAIN_MAJOR/bin"
fi
for exe in initdb pg_ctl postgres createdb pg_dump pg_restore; do
  [[ -x "$PG_BIN/$exe" ]] || fail "Missing version-matched PostgreSQL binary: $PG_BIN/$exe"
done
PG_VERSION_TEXT="$("$PG_BIN/postgres" --version)" || fail 'Cannot inspect PostgreSQL server binary'
if [[ "$PG_VERSION_TEXT" =~ PostgreSQL\)?[[:space:]]+([0-9]+)([.]|$) ]]; then
  [[ "${BASH_REMATCH[1]}" == "$MAIN_MAJOR" ]] || fail 'PostgreSQL major mismatch'
else
  fail 'Unrecognized PostgreSQL server version'
fi
[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Unsupported local OS username'
[[ "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Unsupported local OS group'
# Exact socket/data-directory proof is checked before ANY replay DDL.
PORT=55432
BASE=''
DATA=''
SOCKET=''
STARTED=0
CMP_DIR=''
cleanup() {
  local code=$? stopped=1
  trap - EXIT
  set +e
  if [[ -n "$CMP_DIR" && "$CMP_DIR" =~ ^/tmp/pulse-recovery-compare-[A-Za-z0-9]{8}$ ]]; then
    rm -rf -- "$CMP_DIR"
  fi
  if [[ -n "$BASE" && "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
      sudo -u postgres test -f "$BASE/.pulse-recovery-rehearsal-marker"; then
    if [[ "$STARTED" -eq 1 ]]; then
      echo '========== STOP ISOLATED RECOVERY POSTGRESQL =========='
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null ||
        sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null || stopped=0
    fi
    if [[ "$stopped" -eq 1 ]] &&
       ! sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres rm -rf -- "$BASE" || stopped=0
    else
      stopped=0
    fi
    if [[ "$stopped" -eq 0 ]]; then
      echo "CRITICAL: isolated recovery cluster retained at $BASE; inspect manually" >&2
      code=1
    else
      echo 'PASS: temporary cluster, synthetic records and private backup archive removed'
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
CMP_DIR="$(mktemp -d /tmp/pulse-recovery-compare-XXXXXXXX)"
chmod 0700 "$CMP_DIR"
BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] || fail 'Unexpected temporary cluster path'
DATA="$BASE/data"
SOCKET="$BASE/socket"
sudo -u postgres touch "$BASE/.pulse-recovery-rehearsal-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"
sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

echo '========== START ISOLATED UNIX-ONLY POSTGRESQL =========='
sudo -u postgres "$PG_BIN/initdb" -D "$DATA" --username=postgres \
  --auth-local=peer --auth-host=reject --no-instructions >/dev/null
sudo -u postgres tee "$DATA/pg_ident.conf" >/dev/null <<IDENT
pulse_recovery $(id -un) pulse_metrics_migrator
pulse_recovery $(id -un) pulse_metrics_app
IDENT
sudo -u postgres tee "$DATA/pg_hba.conf" >/dev/null <<'HBA'
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_recovery
local pulse_metrics pulse_metrics_app peer map=pulse_recovery
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
STARTED=1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/start.log" -w start >/dev/null
ISOLATION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U postgres -d postgres -c "SELECT current_setting('data_directory') || '|' || current_user || '|' || (inet_server_addr() IS NULL)::text || '|' || (current_setting('listen_addresses')='')::text")"
[[ "$ISOLATION" == "$DATA|postgres|true|true" ]] || fail 'Isolated PostgreSQL data directory/socket not verified'
echo 'PASS: independent data directory, peer auth and TCP-disabled socket verified'
psql_admin() {
  local database="$1"; shift
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$database" "$@"
}
# Initial bootstraps can create cluster-wide roles. Only this temp socket is used.
echo '========== RECREATE REVIEWED DATABASE FROM ORIGINAL SQL =========='
psql_admin postgres -q < scripts/replay/bootstrap-roles.sql
sudo -u postgres "$PG_BIN/createdb" -h "$SOCKET" -p "$PORT" \
  -U postgres -O postgres pulse_metrics
psql_admin pulse_metrics -q < scripts/replay/bootstrap-database.sql
PULSE_REPLAY_SOCKET="$SOCKET" PULSE_REPLAY_DATA="$DATA" PULSE_REPLAY_PORT="$PORT" \
  node scripts/replay/migrate-isolated.mjs
psql_admin pulse_metrics -q < scripts/replay/runtime-grants.sql
psql_admin pulse_metrics -q < scripts/migrations/ledger-bootstrap.sql
MANIFEST_STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)" || fail 'Manifest verification failed'
[[ "$(printf '%s\n' "$MANIFEST_STEPS" | wc -l)" -eq 6 ]] || fail 'Expected exactly six admin scripts'
while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ && "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ &&
      "$source" == scripts/admin/${version}_* && "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'Unexpected privileged SQL manifest record'
  echo "Apply security step $version to isolated source only"
  {
    printf 'BEGIN READ ONLY;\n'
    printf "SELECT set_config('pulse.replay_step_version','%s',true);\n" "$version"
    cat scripts/migrations/step-preflight-assert.sql
    printf 'COMMIT;\n'
  } | psql_admin pulse_metrics -q >/dev/null
  psql_admin pulse_metrics -q < "$source"
  psql_admin pulse_metrics -q -v "version=$version" -v "source_path=$source" -v "digest=$digest" \
    < scripts/migrations/ledger-record.sql
done <<< "$MANIFEST_STEPS"
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
psql_admin pulse_metrics -q < scripts/recovery/create-synthetic-fixture.sql

# These two snapshots are private to /tmp, contain hashes/metadata only,
# and never include the contents of real development/customer tables.
psql_admin pulse_metrics -Atq < scripts/recovery/fixture-fingerprint.sql > "$CMP_DIR/fixture-before.txt"
psql_admin pulse_metrics -Atq < scripts/replay/catalog-manifest.sql > "$CMP_DIR/catalog-before.txt"
FIXTURE_BEFORE="$(grep -E '^[0-9a-f]{64}$' "$CMP_DIR/fixture-before.txt")"
[[ "$FIXTURE_BEFORE" =~ ^[0-9a-f]{64}$ ]] || fail 'Cannot fingerprint original synthetic fixture'
[[ "$(sha256sum "$CMP_DIR/catalog-before.txt" | cut -d' ' -f1)" == "$BASELINE_HASH" ]] ||
  fail 'Isolated source catalog drifted before backup'
echo 'PASS: original synthetic data, security manifest and catalog baseline verified'

echo '========== CREATE ENCRYPTION-FREE THROWAWAY BACKUP (SYNTHETIC ONLY) =========='
# Do NOT reuse this command on real customer data without encryption-at-rest,
# restricted access, retention, offsite copies, global-role backup and restore controls.
BACKUP="$BASE/recovery-only.dump"
sudo -u postgres "$PG_BIN/pg_dump" --format=custom --no-password \
  -h "$SOCKET" -p "$PORT" -U postgres -f "$BACKUP" pulse_metrics
sudo -u postgres chmod 0600 "$BACKUP"
sudo -u postgres "$PG_BIN/pg_restore" --list "$BACKUP" > "$CMP_DIR/archive-toc.txt"
[[ -s "$BACKUP" ]] || fail 'Dump archive missing or empty'
for object in 'TABLE DATA public users' 'TABLE DATA public organizations' \
              'TABLE DATA pulse_security_migrations applied_privileged_steps'; do
  grep -Fq "$object" "$CMP_DIR/archive-toc.txt" || fail "Backup lacks essential object: $object"
done
echo "PASS: synthetic-only pg_dump custom archive created (sha256: $(sudo -u postgres sha256sum "$BACKUP" | cut -d' ' -f1))"

echo '========== RESTORE INTO A BRAND-NEW DATABASE IN THE DISPOSABLE CLUSTER =========='
# Keeping the source under a new name permits direct comparison of both
# copies while the exact original pulse_metrics name is free for the restore.
# The whole cluster will be deleted on exit; NO default-socket SQL writes.
psql_admin postgres -q -c 'ALTER DATABASE pulse_metrics RENAME TO pulse_metrics_backup_source;'
sudo -u postgres "$PG_BIN/createdb" -h "$SOCKET" -p "$PORT" \
  -U postgres -O postgres -T template0 pulse_metrics
psql_admin pulse_metrics -q < scripts/replay/bootstrap-database.sql
# Restoring as isolated postgres preserves the security-function owners,
# table privileges, ledger contents and RLS definitions from our trusted dump.
sudo -u postgres "$PG_BIN/pg_restore" --single-transaction --exit-on-error \
  --no-password -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics "$BACKUP" \
  > "$CMP_DIR/restore-output.txt"
echo 'PASS: pg_restore completed atomically in the isolated target database'

psql_admin pulse_metrics -q < scripts/recovery/recovered-state-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -Atq < scripts/recovery/fixture-fingerprint.sql > "$CMP_DIR/fixture-after.txt"
psql_admin pulse_metrics -Atq < scripts/replay/catalog-manifest.sql > "$CMP_DIR/catalog-after.txt"
# Row-level/data and structural identity are independently compared.
cmp -s "$CMP_DIR/fixture-before.txt" "$CMP_DIR/fixture-after.txt" ||
  fail 'Synthetic table/ledger contents changed during restore'
# PostgreSQL 16 pg_dump/pg_restore may deparse two specific CHECK-array
# expressions into textually different but equivalent explicit text casts.
# The independent verifier requires the ORIGINAL reviewed source fingerprint
# and permits ONLY the two exact documented expression substitutions.
# All other metadata differences remain a hard failure, with a focused diff.
python3 scripts/recovery/verify-restored-catalog.py \
  "$CMP_DIR/catalog-before.txt" "$CMP_DIR/catalog-after.txt" || \
  fail 'Restored security catalog differs beyond the two reviewed CHECK deparse forms'
echo 'PASS: synthetic row fingerprints and strictly reviewed security catalog parity'

# Application role MUST remain restricted after restore. First prove socket,
# role and target database, then enforce direct-access failures.
RUNTIME_INFO="$(psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_app -d pulse_metrics \
  -c "SELECT current_user || '|' || current_database() || '|' || (inet_server_addr() IS NULL)::text")" ||
  fail 'Restricted runtime cannot connect to the intended restored database'
[[ "$RUNTIME_INFO" == 'pulse_metrics_app|pulse_metrics|true' ]] || fail 'Runtime connected to an unexpected target'
for query in \
  'SELECT * FROM public.agent_credentials LIMIT 1' \
  'SELECT * FROM public.invitation_rate_limits LIMIT 1' \
  'SELECT * FROM pulse_security_migrations.applied_privileged_steps LIMIT 1' \
  'CREATE TABLE public.recovery_forbidden_table (id integer)'; do
  if psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
       -U pulse_metrics_app -d pulse_metrics -c "$query" >/dev/null 2>&1; then
    fail 'Restricted role unexpectedly gained private access after restore'
  fi
done
echo 'PASS: restricted runtime denies secret-table, migration-ledger and DDL access'

# Final read-only inspection of original working database. No customer rows.
MAIN_LAST="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)" ||
  fail 'Cannot recheck original local database catalog'
[[ "$MAIN_LAST" == "$BASELINE_HASH" ]] || fail 'Existing database catalog changed during rehearsal'
echo 'PASS: working development database catalog remained unchanged'
echo '========== BACKUP AND RESTORE REHEARSAL COMPLETED =========='
echo 'PASS: synthetic full archive, one transactional restore, data + ledger + RLS parity and restricted runtime probes'
echo 'NOTE: roles stayed in the disposable cluster; this is not whole-cluster disaster recovery.'
echo 'NOTE: no real customer/dev rows were dumped and no existing database was modified.'
