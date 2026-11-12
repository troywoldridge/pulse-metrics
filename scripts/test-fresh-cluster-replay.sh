#!/usr/bin/env bash
# Phase 2E3C5C2A — Versioned replay plus failure and drift rehearsals.
# Existing development database remains read-only; do not use for production.
# inside the user's existing cluster. No TCP listener; roles never reach main.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Ignore ambient libpq routing overrides. Every replay connection uses an
# explicit, unique Unix-socket path and role; baseline audit uses local default.
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGCLUSTER || true

fail() { echo "ERROR: $*" >&2; exit 1; }
[[ -f .env ]] || fail 'Local development .env is required as an environment guard.'
for binary in node sudo psql pg_config sha256sum mktemp git; do
  command -v "$binary" >/dev/null || fail "Missing prerequisite: $binary"
done
node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw) throw Error('Local runtime DATABASE_URL is required');
const u = new URL(raw);
if (!['postgres:','postgresql:'].includes(u.protocol) ||
    !['localhost','127.0.0.1','::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(u.username) !== 'pulse_metrics_app' ||
    process.env.NODE_ENV === 'production') {
  throw Error('Refusing nonlocal/non-development runtime configuration');
}
console.log('PASS: development runtime guard');
NODE

# All original database sources are required to match the reviewed baseline.
# Never rewrite the originals to remove their local-database guards.
sha256sum --check --status <<'HASHES' || fail 'Migration sources changed: review before replay'
d49e23396a343852627ceab778521adaefc6382c2be6111bf83bf3e59ad870e1  drizzle/0000_damp_tomorrow_man.sql
ae17ed491915e7870467d73ca34cf9ac7c6d6157cc621986ceb3bf60999af26e  drizzle/meta/_journal.json
14f261b4bf7802a92e4c15d7f67cb563ad755fdf2bc4bcc1b7e39b8ad1d8aab7  scripts/admin/001_workos_identity_provisioning.sql
89a0251114f1839fb8449c41f62cb8c4f2d197a34155595746b66bd183c785dc  scripts/admin/002_organization_onboarding.sql
c07bb1a17375eb8b9522092b1d23a5f6aa4a21571c6e590aa34b3f0b27410e42  scripts/admin/003_organization_invitations.sql
d34fe9b8de7cec1e9109caefa7f33879f55188f00f051c8e2efb81d3bc4d4c9f  scripts/admin/004_organization_invitation_acceptance.sql
0bf20d0d11ad87505e7a0f58b61b85c6bb26413baef925c34da1b209c4476121  scripts/admin/005_workos_verified_email_sync.sql
597be8dfd60cff05947a1511f5ff6853bed6601b5e62bf9164f24f4943b33327  scripts/admin/006_invitation_rate_limits.sql
HASHES

echo 'PASS: foundational Drizzle SQL and six original privileged scripts unchanged'

# Independently pinned manifest; no in-place source rewrites or arbitrary paths.
MANIFEST_STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)" ||
  fail 'Privileged SQL manifest verification failed'
[[ "$(printf '%s\n' "$MANIFEST_STEPS" | wc -l)" -eq 6 ]] ||
  fail 'Privileged manifest must list exactly six reviewed steps'
echo 'PASS: versioned privileged SQL manifest, order and SHA-256 verified'

# Local service inspection is read-only. This never obtains a production URL.
MAIN_VERSION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics -c "SELECT current_setting('server_version_num')")" || fail 'Cannot inspect local baseline PostgreSQL'
[[ "$MAIN_VERSION" =~ ^[0-9]{5,6}$ ]] || fail 'Unexpected baseline PostgreSQL version'
MAIN_MAJOR="$((MAIN_VERSION / 10000))"
PG_BIN="$(pg_config --bindir)"
if [[ -x "/usr/lib/postgresql/${MAIN_MAJOR}/bin/initdb" ]]; then
  PG_BIN="/usr/lib/postgresql/${MAIN_MAJOR}/bin"
fi
for exe in initdb pg_ctl postgres createdb; do
  [[ -x "$PG_BIN/$exe" ]] || fail "PostgreSQL binary missing: $PG_BIN/$exe"
done
# PostgreSQL formats this as `postgres (PostgreSQL) 16.15 (...)`, not
# `PostgreSQL 16.15`. Match the actual postgres binary rather than the
# pg_config version; keep an exact numeric major-version comparison.
REPLAY_VERSION_TEXT="$("$PG_BIN/postgres" --version)" ||
  fail 'Could not inspect temporary-cluster PostgreSQL binary version'
if [[ "$REPLAY_VERSION_TEXT" =~ PostgreSQL\)?[[:space:]]+([0-9]+)([.]|$) ]]; then
  REPLAY_MAJOR="${BASH_REMATCH[1]}"
else
  fail 'Cannot parse temporary-cluster PostgreSQL binary version; refusing replay'
fi
[[ "$REPLAY_MAJOR" == "$MAIN_MAJOR" ]] ||
  fail "Replay PostgreSQL major ($REPLAY_MAJOR) differs from local baseline ($MAIN_MAJOR)"
echo "PASS: temporary-cluster PostgreSQL major $REPLAY_MAJOR matches local baseline"
[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Unexpected local OS user for peer authentication'

BASE=''
DATA=''
SOCKET=''
STARTED=0
CMP_DIR=''
PORT=55432
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if [[ -n "$CMP_DIR" && "$CMP_DIR" =~ ^/tmp/pulse-replay-compare-[A-Za-z0-9]{8}$ ]]; then
    rm -rf -- "$CMP_DIR"
  fi
  if [[ -n "$BASE" && "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
      sudo -u postgres test -f "$BASE/.pulse-replay-marker"; then
    local stopped=1
    if [[ "$STARTED" -eq 1 ]]; then
      echo '========== STOP ISOLATED POSTGRESQL =========='
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
      echo "CRITICAL: isolated cluster cleanup incomplete; directory retained: $BASE" >&2
      result=1
    else
      echo 'PASS: isolated cluster, roles, database and socket removed'
    fi
  fi
  exit "$result"
}
trap cleanup EXIT

CMP_DIR="$(mktemp -d /tmp/pulse-replay-compare-XXXXXXXX)"
chmod 0700 "$CMP_DIR"
BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] || fail 'Unexpected temporary cluster location'
DATA="$BASE/data"
SOCKET="$BASE/socket"
sudo -u postgres touch "$BASE/.pulse-replay-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"
# Unix socket directory is reachable only by postgres and the invoking user's group.
[[ "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Unexpected Unix group name'
sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

echo '========== INITIALIZE DISPOSABLE POSTGRESQL CLUSTER =========='
sudo -u postgres "$PG_BIN/initdb" -D "$DATA" --username=postgres \
  --auth-local=peer --auth-host=reject --no-instructions >/dev/null
# Peer authentication is restricted to postgres and the invoking OS user,
# which may only impersonate temporary migrator and runtime DB roles.
sudo -u postgres tee "$DATA/pg_ident.conf" >/dev/null <<IDENT
pulse_replay $(id -un) pulse_metrics_migrator
pulse_replay $(id -un) pulse_metrics_app
IDENT
sudo -u postgres tee "$DATA/pg_hba.conf" >/dev/null <<'HBA'
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_replay
local pulse_metrics pulse_metrics_app peer map=pulse_replay
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
STARTED=1

# A positive proof of exact data directory and Unix transport precedes DDL.
REPLAY_INFO="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At \
  -h "$SOCKET" -p "$PORT" -U postgres -d postgres \
  -c "SELECT current_setting('data_directory') || '|' || current_database() || '|' || current_user || '|' || (inet_server_addr() IS NULL)::text || '|' || (current_setting('listen_addresses') = '')::text")"
[[ "$REPLAY_INFO" == "$DATA|postgres|postgres|true|true" ]] || fail 'Replay connection cannot be proven isolated'
echo 'PASS: private data directory and Unix-only PostgreSQL connection verified'

psql_admin() {
  local replay_database="$1"
  shift
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$replay_database" "$@"
}

echo '========== CREATE REPLAY-ONLY ROLES AND DATABASE =========='
psql_admin postgres < scripts/replay/bootstrap-roles.sql
sudo -u postgres "$PG_BIN/createdb" -h "$SOCKET" -p "$PORT" \
  -U postgres -O postgres pulse_metrics
psql_admin pulse_metrics < scripts/replay/bootstrap-database.sql

echo '========== RUN ORIGINAL DRIZZLE MIGRATION =========='
PULSE_REPLAY_SOCKET="$SOCKET" PULSE_REPLAY_DATA="$DATA" PULSE_REPLAY_PORT="$PORT" \
  node scripts/replay/migrate-isolated.mjs

psql_admin pulse_metrics < scripts/replay/runtime-grants.sql

echo '========== INSTALL PRIVATE REPLAY MIGRATION LEDGER =========='
psql_admin pulse_metrics < scripts/migrations/ledger-bootstrap.sql

# Never rerun a non-idempotent original security bootstrap when its verified
# receipt is present. If the script succeeds but receipt insertion fails, the
# next invocation refuses to overwrite existing SQL objects: manual review is
# required. That crash gap is deliberately not concealed by fake ledger rows.
apply_privileged_steps() {
  local pass="$1"
  local version source digest recorded
  while IFS=$'\t' read -r version source digest; do
    [[ "$version" =~ ^00[1-6]$ &&
       "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ &&
       "$source" == scripts/admin/${version}_* &&
       "$digest" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid manifest output; refusing admin SQL execution'
    recorded="$(psql_admin pulse_metrics -Atq -v "version=$version" <<'SQL'
SELECT source_sha256 FROM pulse_security_migrations.applied_privileged_steps
WHERE version=:'version';
SQL
)" || fail 'Could not inspect isolated privileged ledger'
    if [[ -n "$recorded" ]]; then
      [[ "$recorded" == "$digest" ]] || fail "Checksum drift in recorded step $version"
      echo "SKIP $version: previously recorded with matching reviewed SHA-256"
      continue
    fi
    [[ "$pass" == 'initial' ]] || fail "Step $version missing on repeated pass; refusing SQL replay"
    echo "Preflight reviewed step $version: reject unrecorded preexisting objects"
    # Stream SQL as the invoking user: the postgres OS account cannot be
    # assumed to traverse the project's private home directory.
    {
      printf 'BEGIN READ ONLY;\n'
      printf "SELECT set_config('pulse.replay_step_version', '%s', true);\n" "$version"
      cat scripts/migrations/step-preflight-assert.sql
      printf 'COMMIT;\n'
    } | psql_admin pulse_metrics -q
    echo "Applying original reviewed $version in isolated cluster only"
    psql_admin pulse_metrics < "$source"
    psql_admin pulse_metrics -v "version=$version" -v "source_path=$source" -v "digest=$digest" \
      < scripts/migrations/ledger-record.sql
    echo "RECORDED $version: verified postconditions and source SHA-256"
  done <<< "$MANIFEST_STEPS"
}

echo '========== REPLAY SIX REVIEWED PRIVILEGED SQL SOURCES =========='
apply_privileged_steps initial

echo '========== REPEAT DEPLOYMENT: SIX STEPS MUST SKIP =========='
apply_privileged_steps repeated
psql_admin pulse_metrics < scripts/migrations/ledger-audit.sql

echo '========== REHEARSE MISSING RECEIPT AFTER SQL COMMIT =========='
# Simulate the receipt-write crash gap in ONE uncommitted transaction.
# The real preflight must refuse an existing function/table despite missing
# receipt; psql disconnect automatically rolls the simulated deletion back.
if {
  printf 'BEGIN;\n'
  printf "DELETE FROM pulse_security_migrations.applied_privileged_steps WHERE version='006';\n"
  printf "SELECT set_config('pulse.replay_step_version', '006', true);\n"
  cat scripts/migrations/step-preflight-assert.sql
  printf 'COMMIT;\n'
} | psql_admin pulse_metrics -q > "$CMP_DIR/missing-receipt.log" 2>&1; then
  fail 'Missing-receipt replay was unexpectedly allowed'
fi
grep -Fq 'UNRECORDED_EXISTING_OBJECT' "$CMP_DIR/missing-receipt.log" ||
  fail 'Missing-receipt preflight failed for a reason other than existing objects'
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
echo 'PASS: missing receipt with installed objects refused; uncommitted simulation rolled back'

echo '========== REHEARSE TRANSACTIONAL MIGRATION FAILURE =========='
if psql_admin pulse_metrics -q > "$CMP_DIR/rollback.log" 2>&1 <<'SQL'
BEGIN;
SET LOCAL ROLE pulse_metrics_migrator;
CREATE TABLE public.pulse_replay_failure_probe (id integer);
DO $intentional$ BEGIN RAISE EXCEPTION 'INTENTIONAL_MIGRATION_ROLLBACK'; END $intentional$;
COMMIT;
SQL
then
  fail 'Intentional failure drill unexpectedly committed'
fi
grep -Fq 'INTENTIONAL_MIGRATION_ROLLBACK' "$CMP_DIR/rollback.log" ||
  fail 'Failure drill failed for an unexpected reason'
psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;
DO $check$
BEGIN
 IF to_regclass('public.pulse_replay_failure_probe') IS NOT NULL THEN
   RAISE EXCEPTION 'Transactional failure left a table behind';
 END IF;
 IF (SELECT count(*) FROM pulse_security_migrations.applied_privileged_steps)<>6
    OR (SELECT count(*) FROM public.__drizzle_migrations)<>1 THEN
   RAISE EXCEPTION 'Transactional failure altered migration history';
 END IF;
END;
$check$;
COMMIT;
SQL
echo 'PASS: intentional transactional DDL failure left no table and preserved all receipts'

echo '========== VERIFY ISOLATED REPLAY SECURITY BASELINE =========='
psql_admin pulse_metrics < scripts/audit/migration-security-invariants.sql

echo '========== NEGATIVE RESTRICTED-ROLE ACCESS TEST =========='
# Connection goes through the temporary Unix socket and OS-peer mapping.
if psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_app -d pulse_metrics \
  -c 'SELECT * FROM public.invitation_rate_limits LIMIT 1' >/dev/null 2>&1; then
  fail 'Runtime role unexpectedly reads protected rate-limit counters'
fi
if psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_app -d pulse_metrics \
  -c 'CREATE TABLE public.unauthorized_replay_probe (id integer)' >/dev/null 2>&1; then
  fail 'Runtime role unexpectedly creates schema objects'
fi
if psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_app -d pulse_metrics \
  -c 'SELECT * FROM pulse_security_migrations.applied_privileged_steps LIMIT 1' >/dev/null 2>&1; then
  fail 'Runtime role unexpectedly reads private migration receipts'
fi
echo 'PASS: application role cannot read private counters, migration receipts or create tables'

echo '========== COMPARE STRUCTURAL METADATA TO CURRENT BASELINE =========='
# Main database is only read through the previous local administrator socket.
# The replay is read through its independent, explicitly identified socket.
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/current.txt"
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/replay.txt"
CURRENT_HASH="$(sha256sum "$CMP_DIR/current.txt" | cut -d' ' -f1)"
REPLAY_HASH="$(sha256sum "$CMP_DIR/replay.txt" | cut -d' ' -f1)"
echo "Current catalog fingerprint: $CURRENT_HASH"
echo "Replay catalog fingerprint:  $REPLAY_HASH"
if [[ "$CURRENT_HASH" != "$REPLAY_HASH" ]]; then
  echo 'Structural catalog differences detected (metadata only; no customer rows):' >&2
  diff -u "$CMP_DIR/current.txt" "$CMP_DIR/replay.txt" | head -100 || true
  fail 'Structural parity needs investigation; original database left unchanged'
fi
echo 'PASS: database catalog metadata matches the reviewed existing database'

echo '========== INJECT AND DETECT TEMPORARY PERMISSION DRIFT =========='
# This grant is made ONLY on the previously verified disposable socket.
# The test intentionally widens a restricted table privilege briefly so the
# real structural manifest must detect it. No customer data is present.
psql_admin pulse_metrics -q <<'SQL'
BEGIN;
GRANT SELECT ON public.invitation_rate_limits TO pulse_metrics_app;
COMMIT;
SQL
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/drifted.txt"
if cmp -s "$CMP_DIR/current.txt" "$CMP_DIR/drifted.txt"; then
  fail 'Injected unsafe runtime grant was NOT detected as drift'
fi
grep -Fq 'grant|invitation_rate_limits|SELECT|true' "$CMP_DIR/drifted.txt" ||
  fail 'Expected unsafe direct-grant drift is missing from catalog metadata'
echo 'PASS: structural catalog comparison detected an unsafe direct-table grant'
psql_admin pulse_metrics -q <<'SQL'
BEGIN;
REVOKE SELECT ON public.invitation_rate_limits FROM pulse_metrics_app;
COMMIT;
SQL
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/restored.txt"
if ! cmp -s "$CMP_DIR/current.txt" "$CMP_DIR/restored.txt"; then
  fail 'Catalog did not return to the reviewed baseline after restoring grant'
fi
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
echo 'PASS: isolated grant removed; exact structural baseline restored'

echo '========== FRESH CLUSTER REPLAY COMPLETED =========='
echo 'PASS: real Drizzle migration, six checksummed privileged receipts, repeat-skip, forced RLS, least privilege and catalog parity'
echo 'NOTE: existing database NOT stamped; fresh-cluster receipts are ephemeral, not adopted production history.'
