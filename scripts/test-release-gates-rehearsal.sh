#!/usr/bin/env bash
# Pulse Metrics Phase 2E3C5D3 — synthetic release gate integration rehearsal.
# All writes confined to a separately created, marker-guarded Unix-only
# PostgreSQL cluster. NEVER executes DDL on the developer's real database.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT || true
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -f .env ]] || fail 'Reviewed local .env development guard missing'
for bin in node sudo psql pg_config sha256sum mktemp git python3 cmp; do
  command -v "$bin" >/dev/null || fail "Missing prerequisite: $bin"
done
node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw || process.env.NODE_ENV === 'production') throw Error('Production or missing database refused');
const u = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(u.username) !== 'pulse_metrics_app') {
  throw Error('Only the reviewed local runtime development target is permitted');
}
console.log('PASS: strict local development runtime guard');
NODE
node scripts/migrations/verify-manifest.mjs
# The original developer database is inspected READ ONLY by this prerequisite.
bash scripts/migrations/audit-adoption-drift.sh
BASELINE='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
MAIN_VERSION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics \
  -c "SELECT current_setting('server_version_num')")" || fail 'Local database version inspect failed'
[[ "$MAIN_VERSION" =~ ^[0-9]{5,6}$ ]] || fail 'Invalid local version'
MAIN_MAJOR="$((MAIN_VERSION / 10000))"
PG_BIN="$(pg_config --bindir)"
if [[ -x "/usr/lib/postgresql/$MAIN_MAJOR/bin/initdb" ]]; then
  PG_BIN="/usr/lib/postgresql/$MAIN_MAJOR/bin"
fi
for bin in initdb pg_ctl postgres psql createdb; do
  [[ -x "$PG_BIN/$bin" ]] || fail "Missing PostgreSQL binary $PG_BIN/$bin"
done
PG_VERSION_TEXT="$("$PG_BIN/postgres" --version)"
if [[ "$PG_VERSION_TEXT" =~ PostgreSQL\)?[[:space:]]+([0-9]+)([.]|$) ]]; then
  [[ "${BASH_REMATCH[1]}" == "$MAIN_MAJOR" ]] || fail 'PG major mismatch'
else
  fail 'Unexpected PostgreSQL server version'
fi
[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ && "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
  fail 'Unexpected OS username/group'
BASE=''; DATA=''; SOCKET=''; STARTED=0
PORT=55432
cleanup() {
  local code=$? stopped=1
  trap - EXIT
  set +e
  if [[ -n "$BASE" && "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
     sudo -u postgres test -f "$BASE/.pulse-release-lock-marker"; then
    echo '========== CLEAN UP DISPOSABLE RELEASE CLUSTER =========='
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
      echo "CRITICAL: temporary cluster retained for safe manual inspection: $BASE" >&2
      code=1
    else
      echo 'PASS: synthetic database, SQL objects and disposable cluster removed'
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] || fail 'Unexpected temporary cluster path'
DATA="$BASE/data"
SOCKET="$BASE/socket"
sudo -u postgres touch "$BASE/.pulse-release-lock-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"
sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

echo '========== INITIALIZE ISOLATED RELEASE TEST CLUSTER =========='
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
STARTED=1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/start.log" -w start >/dev/null
ISOLATION="$(sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At \
 -h "$SOCKET" -p "$PORT" -U postgres -d postgres -c \
 "SELECT current_setting('data_directory') || '|' || current_user || '|' ||
 (inet_server_addr() IS NULL)::text || '|' || (current_setting('listen_addresses')='')::text")"
[[ "$ISOLATION" == "$DATA|postgres|true|true" ]] || fail 'Disposable PostgreSQL socket/data directory not verified'
echo 'PASS: independent data directory, peer-auth local-only socket and server identity verified'
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
MANIFEST_STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)" || fail 'Review manifest rejected'
[[ "$(printf '%s\n' "$MANIFEST_STEPS" | wc -l)" -eq 6 ]] || fail 'Expected exactly six reviewed steps'
while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ && "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ &&
    "$source" == scripts/admin/${version}_* && "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'Invalid immutable privileged migration source'
  {
    printf 'BEGIN READ ONLY;\n'
    printf "SELECT set_config('pulse.replay_step_version','%s',true);\n" "$version"
    cat scripts/migrations/step-preflight-assert.sql
    printf 'COMMIT;\n'
  } | psql_admin pulse_metrics -q >/dev/null
  psql_admin pulse_metrics -q < "$source"
  psql_admin pulse_metrics -q -v "version=$version" -v "source_path=$source" \
    -v "digest=$digest" < scripts/migrations/ledger-record.sql
  echo "RECORDED reviewed original step $version in disposable test database only"
done <<< "$MANIFEST_STEPS"
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
BEFORE="$(psql_admin pulse_metrics -Atq < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$BEFORE" == "$BASELINE" ]] || fail 'Baseline catalog differs before test-only release controls'
psql_admin pulse_metrics -q < scripts/release/rehearsal-control-bootstrap.sql
# Before test release, validate that our ordinary non-superuser migrator can
# connect only by the explicit isolated Unix socket.
MIGRATOR_INFO="$("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At \
  -h "$SOCKET" -p "$PORT" -U pulse_metrics_migrator -d pulse_metrics -c \
  "SELECT current_user || '|' || current_database() || '|' || (inet_server_addr() IS NULL)::text")"
[[ "$MIGRATOR_INFO" == 'pulse_metrics_migrator|pulse_metrics|true' ]] ||
  fail 'Migrator connection is not isolated and role-scoped'

echo '========== TEST SIGNED APPROVALS, ADVISORY LOCKS AND TRANSACTION ROLLBACK =========='
PULSE_RELEASE_DISPOSABLE_ONLY=YES PULSE_RELEASE_SOCKET="$SOCKET" PULSE_RELEASE_DATA="$DATA" \
  node scripts/release/rehearsal-integration.mjs

echo '========== AUDIT TEST-ONLY RELEASE RECEIPT AND LEAST PRIVILEGE =========='
psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;
DO $check$
BEGIN
 IF current_database()<>'pulse_metrics' OR current_user<>'postgres'
    OR (SELECT count(*) FROM pulse_release_rehearsal.release_receipts)<>1
    OR (SELECT count(*) FROM pulse_release_rehearsal.applied_canary)<>1
    OR (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6
    OR (SELECT count(*) FROM public.__drizzle_migrations)<>1
    OR has_schema_privilege('pulse_metrics_app','pulse_release_rehearsal','USAGE')
    OR has_table_privilege('pulse_metrics_app',
        'pulse_release_rehearsal.release_receipts','SELECT')
    OR has_table_privilege('pulse_metrics_migrator',
        'pulse_release_rehearsal.release_receipts','UPDATE')
    OR has_table_privilege('pulse_metrics_migrator',
        'pulse_release_rehearsal.release_receipts','DELETE')
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE
       oid='pulse_release_rehearsal.release_receipts'::regclass
       AND relrowsecurity AND relforcerowsecurity AND relowner='postgres'::regrole) THEN
  RAISE EXCEPTION 'RELEASE_AUDIT_FAILED: receipt/role isolation or historic ledger changed';
 END IF;
 RAISE NOTICE 'PASS: receipt append-only for migrator, FORCE RLS, app role excluded, original history unchanged';
END;
$check$;
COMMIT;
SQL
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
AFTER="$(psql_admin pulse_metrics -Atq < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)"
[[ "$AFTER" == "$BASELINE" ]] || fail 'Public reviewed catalog drifted during release test'
if "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
   -U pulse_metrics_app -d pulse_metrics -c \
   'SELECT * FROM pulse_release_rehearsal.release_receipts LIMIT 1' >/dev/null 2>&1; then
  fail 'Ordinary runtime unexpectedly read test-only private release receipts'
fi
MAIN_AFTER="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)" ||
  fail 'Final development baseline read-only inspection failed'
[[ "$MAIN_AFTER" == "$BASELINE" ]] || fail 'Existing developer database catalog changed'
echo '========== RELEASE LOCK/APPROVAL REHEARSAL COMPLETED =========='
echo 'PASS: two signed test approvals, held-session contention, auto-unlock, failure rollback, one commit and duplicate refusal'
echo 'PASS: unchanged original SQL/Drizzle ledger, private release receipts, app role isolation and read-only dev baseline'
echo 'NOTE: synthetic test signers; NOT a real operator authorization system or production migration runner'
