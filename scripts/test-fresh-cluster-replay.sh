#!/usr/bin/env bash
# Phase 2E3C5B — Disposable PRIVATE PostgreSQL CLUSTER replay; NOT a second DB
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
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$1"
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

echo '========== REPLAY SIX UNMODIFIED PRIVILEGED SQL SOURCES =========='
for n in 001 002 003 004 005 006; do
  mapfile -t sql_files < <(compgen -G "scripts/admin/${n}_*.sql" || true)
  [[ "${#sql_files[@]}" -eq 1 ]] || fail "Expected one administrator source with prefix $n"
  echo "Applying $n to isolated database only"
  psql_admin pulse_metrics < "${sql_files[0]}"
done

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
echo 'PASS: application role cannot read private counters or create tables'

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
echo '========== FRESH CLUSTER REPLAY COMPLETED =========='
echo 'PASS: real Drizzle replay, six security bootstraps, forced RLS, least privilege and structural comparison'
echo 'NOTE: this is local replay verification, not an adopted production migration history.'
