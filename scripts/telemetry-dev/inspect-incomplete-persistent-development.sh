#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2B1: offline/metadata inspection after PostgreSQL
# rejected the restricted migrator's request for data_directory.
# READ ONLY. No cluster start/stop, migrations, credential reads, or deletions.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { printf 'REFUSE_D15C5U2B1: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 0 ]] || fail 'No arguments accepted'
[[ "$(uname -s)" == 'Linux' && "$(id -u)" -ne 0 ]] || fail 'Linux non-root operator required'
[[ "${NODE_ENV:-development}" != production ]] || fail 'Production environment refused'

for cmd in sudo pg_config stat grep sha256sum psql sed cut; do
  command -v "$cmd" >/dev/null 2>&1 || fail "Missing requirement: $cmd"
done

BASE='/var/lib/postgresql/pulse-metrics-dev-5u2'
DATA="$BASE/data"
SOCKET="$BASE/socket"
MARKER="$BASE/.pulse-5u2-provisioning"
READY="$BASE/.pulse-5u2-ready"
ORIGINAL_HASH='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/pg_controldata" ]] ||
  fail 'Missing PostgreSQL pg_ctl or pg_controldata binaries'

# Verify exact immutable target; never inspect an arbitrary database path.
for path in "$BASE" "$DATA" "$SOCKET"; do
  [[ -d "$path" && ! -L "$path" ]] || fail 'Dedicated directory missing or linked'
done
[[ "$(sudo -u postgres stat -c '%U:%a' "$BASE")" == 'postgres:750' ]] ||
  fail 'Base owner/mode mismatch'
[[ "$(sudo -u postgres stat -c '%U:%a' "$DATA")" == 'postgres:700' ]] ||
  fail 'Data owner/mode mismatch'
[[ "$(sudo -u postgres stat -c '%U:%a' "$SOCKET")" == 'postgres:750' ]] ||
  fail 'Socket directory owner/mode mismatch'
[[ ! -L "$MARKER" && -f "$MARKER" ]] || fail 'Provisioning marker missing or linked'
[[ "$(sudo -u postgres stat -c '%U:%a' "$MARKER")" == 'postgres:600' ]] ||
  fail 'Provisioning marker unsafe'
[[ ! -e "$READY" && ! -L "$READY" ]] ||
  fail 'Readiness marker exists: do not treat as an incomplete installation'
[[ "$(sudo -u postgres cat "$DATA/PG_VERSION")" == '16' ]] ||
  fail 'Unexpected PostgreSQL major version'

echo '========== OFFLINE CLUSTER STATE =========='
if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  fail 'Persistent cluster is running; no offline inspection performed'
fi
# A postmaster.pid may indicate an unresolved shutdown or stale state.
[[ ! -e "$DATA/postmaster.pid" && ! -L "$DATA/postmaster.pid" ]] ||
  fail 'postmaster.pid remains; investigate server process manually'
CONTROL="$(sudo -u postgres "$PG_BIN/pg_controldata" "$DATA")" ||
  fail 'Could not inspect PostgreSQL control file'
STATE="$(printf '%s\n' "$CONTROL" | sed -n 's/^Database cluster state:[[:space:]]*//p')"
[[ "$STATE" == 'shut down' ]] || fail 'Cluster control state is not clean shutdown'
echo 'PASS: cluster stopped cleanly; no server started by inspection'

echo '========== LOCAL-ONLY POSTGRESQL CONFIGURATION =========='
sudo -u postgres grep -Fx -- "listen_addresses = ''" "$DATA/postgresql.conf" >/dev/null || fail 'TCP listener configuration mismatch'
sudo -u postgres grep -Fx -- 'port = 55433' "$DATA/postgresql.conf" >/dev/null || fail 'Port configuration mismatch'
sudo -u postgres grep -Fx -- "unix_socket_directories = '$SOCKET'" "$DATA/postgresql.conf" >/dev/null || fail 'Unix socket configuration mismatch'
sudo -u postgres grep -Fx -- 'ssl = off' "$DATA/postgresql.conf" >/dev/null || fail 'Unexpected SSL configuration'
sudo -u postgres grep -Fx -- 'host all all 0.0.0.0/0 reject' "$DATA/pg_hba.conf" >/dev/null || fail 'IPv4 host HBA reject missing'
sudo -u postgres grep -Fx -- 'host all all ::/0 reject' "$DATA/pg_hba.conf" >/dev/null || fail 'IPv6 host HBA reject missing'
echo 'PASS: configured for dedicated socket and no TCP listener'

echo '========== ORIGINAL DEVELOPMENT DATABASE FINGERPRINT =========='
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT || true
ACTUAL="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql | sha256sum | cut -d' ' -f1)" ||
  fail 'Existing development database read-only fingerprint query failed'
[[ "$ACTUAL" == "$ORIGINAL_HASH" ]] ||
  fail 'Existing development database fingerprint changed'
echo 'PASS: original development database catalog still matches pinned baseline'

echo '========== D15C-5U-2B1 OFFLINE INSPECTION: PASS =========='
echo 'NOTE: This does NOT prove which SQL objects exist inside the stopped cluster.'
echo 'NO DATABASE STARTED | NO MIGRATIONS APPLIED | NO FILES CHANGED'
echo 'PUBLIC LAUNCH: NO_GO'
