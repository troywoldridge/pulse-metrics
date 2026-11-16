#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F2B — one retained, byte-verified LOCAL COLD snapshot.
# SOURCE: exact STOPPED quarantined dev PostgreSQL cluster; never start or edit it.
# TARGET: single fixed, owner-only sibling directory; never overwrite/delete.
# NOT: verified recovery from this retained copy, off-site backup, PITR or release.
set -Eeuo pipefail
umask 077

refuse() { printf 'REFUSE_D15C5U2F2B: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 && ( "$1" == --plan || "$1" == --create || "$1" == --verify ) ]] || refuse 'Use exactly --plan|--create|--verify'
MODE="$1"
[[ "$(uname -s)" == Linux && "$(id -u)" -ne 0 ]] || refuse 'Linux non-root operator required'
[[ "${NODE_ENV:-development}" != production && -z "${NODE_OPTIONS:-}" ]] || refuse 'Production or inherited Node options refused'
[[ -z "${DATABASE_URL:-}" && -z "${MIGRATION_DATABASE_URL:-}" ]] || refuse 'Inherited database URLs refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 ]] || refuse 'Unsafe TLS override refused'
[[ "${PULSE_ENABLE_PUBLIC_INGRESS:-}" != YES && "${PULSE_ENABLE_TELEMETRY_SERVICE:-}" != YES ]] || refuse 'Telemetry activation refused'
if [[ "$MODE" == --create ]]; then
  [[ "${PULSE_APPROVE_5U2F2B_RETAINED_BACKUP:-}" == 'ONE_STOPPED_LOCAL_COPY' ]] || refuse 'Separate exact retained backup approval required'
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
for tool in sudo sha256sum stat grep find sort xargs df du awk cut tr cp mkdir chmod touch mv cat bash pg_config sed; do
  command -v "$tool" >/dev/null 2>&1 || refuse "Missing required tool: $tool"
done
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT PGDATA PGCONNECT_TIMEOUT || true

PARENT='/var/lib/postgresql'
SOURCE_BASE="$PARENT/pulse-metrics-dev-5u2"
SOURCE_DATA="$SOURCE_BASE/data"
BACKUP="$PARENT/pulse-metrics-dev-5u2-cold-backup-5u2f2b"
BACKUP_DATA="$BACKUP/data"
INCOMPLETE="$BACKUP/.pulse-5u2f2b-incomplete"
COMPLETE="$BACKUP/.pulse-5u2f2b-verified"
MANIFEST="$BACKUP/snapshot.meta"
OFFLINE='scripts/telemetry-dev/inspect-incomplete-persistent-development.sh'
OFFLINE_SHA='7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'
PG_BIN="$(pg_config --bindir)"
[[ "$PG_BIN" == /* && -x "$PG_BIN/pg_ctl" && -x "$PG_BIN/pg_controldata" && -x "$PG_BIN/postgres" ]] || refuse 'PostgreSQL binaries missing'
[[ "$("$PG_BIN/postgres" --version)" == *' 16.'* ]] || refuse 'PostgreSQL major 16 required'
[[ -f "$OFFLINE" && ! -L "$OFFLINE" && "$(sha256sum "$OFFLINE" | cut -d' ' -f1)" == "$OFFLINE_SHA" ]] || refuse 'Pinned offline inspector missing or changed'

postgres_unlinked_dir() {
  sudo -u postgres test -d "$1" && sudo -u postgres test ! -L "$1"
}
postgres_unlinked_file() {
  sudo -u postgres test -f "$1" && sudo -u postgres test ! -L "$1"
}
postgres_absent() {
  sudo -u postgres test ! -e "$1" && sudo -u postgres test ! -L "$1"
}

guard_source() {
  # This read-only inspector verifies stopped state, exact source/configuration,
  # quarantine marker and pinned original development DB catalog fingerprint.
  bash "$OFFLINE" || refuse 'Offline baseline inspection failed'
  [[ -d "$PARENT" && ! -L "$PARENT" ]] || refuse 'Unexpected PostgreSQL parent directory'
  postgres_unlinked_dir "$SOURCE_DATA" || refuse 'Missing or linked source data directory'
  postgres_unlinked_dir "$SOURCE_DATA/pg_tblspc" || refuse 'Linked/missing tablespace directory'
  postgres_unlinked_dir "$SOURCE_DATA/pg_wal" || refuse 'Linked/missing WAL directory'
  [[ "$(sudo -u postgres stat -c '%U:%a' "$SOURCE_DATA")" == postgres:700 ]] || refuse 'Source data permission mismatch'
  [[ -z "$(sudo -u postgres find "$SOURCE_DATA/pg_tblspc" -mindepth 1 -maxdepth 1 -print -quit)" ]] || refuse 'External tablespaces unsupported'
  [[ -z "$(sudo -u postgres find "$SOURCE_DATA" ! -type f ! -type d -print -quit)" ]] || refuse 'Unexpected source file or symlink'
  postgres_absent "$SOURCE_DATA/postmaster.pid" || refuse 'Source has a postmaster.pid'
  local cluster_state
  cluster_state="$(sudo -u postgres "$PG_BIN/pg_controldata" "$SOURCE_DATA" | sed -n 's/^Database cluster state:[[:space:]]*//p')" || refuse 'Cannot read source control data'
  [[ "$cluster_state" == 'shut down' ]] || refuse 'Source is not cleanly shut down'
}

snapshot_digest() {
  # Preserve sorted relative file paths in the digest, not just file bytes.
  # PostgreSQL paths are private; this entire walk runs as postgres.
  sudo -u postgres bash -c '
    set -euo pipefail
    cd -- "$1"
    find . -type f -print0 | LC_ALL=C sort -z |
      xargs -0 -r sha256sum -b -- | sha256sum | cut -d " " -f1
  ' bash "$1"
}

regular_file_bytes() {
  # The privileged find reads only file sizes; the operator runs the sum.
  sudo -u postgres find "$1" -type f -printf '%s\n' |
    awk '{ total += $1 } END { printf "%.0f\n", total }'
}

safe_backup_root() {
  postgres_unlinked_dir "$BACKUP" || refuse 'Backup directory missing or linked'
  [[ "$(sudo -u postgres stat -c '%U:%a' "$BACKUP")" == postgres:700 ]] || refuse 'Backup directory ownership/mode mismatch'
}

validate_backup() {
  safe_backup_root
  postgres_unlinked_dir "$BACKUP_DATA" || refuse 'Backup data missing or linked'
  [[ "$(sudo -u postgres stat -c '%U:%a' "$BACKUP_DATA")" == postgres:700 ]] || refuse 'Backup data permissions mismatch'
  postgres_unlinked_dir "$BACKUP_DATA/pg_wal" || refuse 'Backup WAL linked/missing'
  postgres_unlinked_dir "$BACKUP_DATA/pg_tblspc" || refuse 'Backup tablespace linked/missing'
  [[ -z "$(sudo -u postgres find "$BACKUP_DATA/pg_tblspc" -mindepth 1 -maxdepth 1 -print -quit)" ]] || refuse 'Backup has tablespace links'
  [[ -z "$(sudo -u postgres find "$BACKUP_DATA" ! -type f ! -type d -print -quit)" ]] || refuse 'Unsafe file or symlink in backup'
  postgres_absent "$BACKUP_DATA/postmaster.pid" || refuse 'Backup appears started'
  postgres_absent "$INCOMPLETE" || refuse 'Backup is marked incomplete: manual review required'
  postgres_unlinked_file "$COMPLETE" || refuse 'Verified marker missing/linked'
  postgres_unlinked_file "$MANIFEST" || refuse 'Snapshot manifest missing/linked'
  [[ "$(sudo -u postgres stat -c '%U:%a' "$COMPLETE")" == postgres:600 ]] || refuse 'Verified marker permissions unsafe'
  [[ "$(sudo -u postgres stat -c '%U:%a' "$MANIFEST")" == postgres:600 ]] || refuse 'Manifest permissions unsafe'
  local content bytes digest actual size cluster_state
  local expected_metadata=$'^pulse-metrics-5u2f2b-v1\nfile_bytes=([0-9]+)\nfile_digest_sha256=([a-f0-9]{64})$'
  content="$(sudo -u postgres cat "$MANIFEST")" || refuse 'Cannot read snapshot manifest'
  [[ "$content" =~ $expected_metadata ]] || refuse 'Malformed snapshot manifest'
  bytes="${BASH_REMATCH[1]}"
  digest="${BASH_REMATCH[2]}"
  [[ "$bytes" -gt 0 && "$bytes" -le 1073741824 ]] || refuse 'Manifest size outside reviewed range'
  size="$(regular_file_bytes "$BACKUP_DATA")" || refuse 'Backup file byte count unavailable'
  [[ "$size" == "$bytes" ]] || refuse 'Backup byte count differs from retained manifest'
  actual="$(snapshot_digest "$BACKUP_DATA")" || refuse 'Backup digest failed'
  [[ "$actual" == "$digest" ]] || refuse 'Retained snapshot integrity mismatch'
  cluster_state="$(sudo -u postgres "$PG_BIN/pg_controldata" "$BACKUP_DATA" | sed -n 's/^Database cluster state:[[:space:]]*//p')" || refuse 'Cannot inspect backup control data'
  [[ "$cluster_state" == 'shut down' ]] || refuse 'Backup is not a cleanly stopped PostgreSQL cluster'
  echo 'PASS: retained PostgreSQL data directory is byte-verified and cleanly stopped'
  echo "PASS: SHA256 snapshot tree digest $digest"
}

# All modes check the original database safeguard before considering a copy.
guard_source

case "$MODE" in
  --plan)
    echo '========== D15C-5U-2F2B RETAINED COLD SNAPSHOT PLAN =========='
    echo "Stopped source: $SOURCE_DATA"
    echo "Single local retention destination: $BACKUP"
    echo 'Refuse linked data/tablespaces, running source, oversized data or insufficient free space.'
    echo 'Create a postgres-owned 0700 sibling directory without overwriting existing paths.'
    echo 'Copy source data once with full metadata, then SHA256-check the complete file tree.'
    echo 'Retain the copy and metadata without starting the backup or source PostgreSQL.'
    echo 'Incomplete attempts remain quarantined for review, never automatically removed.'
    echo 'Local same-host copy ONLY: not independent recovery, offsite backup, encryption, PITR or production readiness.'
    echo 'NO BACKUP CREATED | NO DATABASE STARTED | NO TELEMETRY WRITES | PUBLIC LAUNCH: NO_GO'
    ;;
  --verify)
    echo '========== VERIFY RETAINED LOCAL COLD SNAPSHOT =========='
    validate_backup
    guard_source
    echo 'PASS: source cluster remained stopped and original development DB unchanged'
    echo 'PUBLIC LAUNCH: NO_GO'
    ;;
  --create)
    # Refuse all existing targets (including symlinks and incomplete attempts).
    postgres_absent "$BACKUP" || refuse 'Snapshot destination already exists; refusing overwrite'
    local_size="$(sudo -u postgres du -sb -- "$SOURCE_DATA" | awk '{print $1}')" || refuse 'Cannot determine source size'
    [[ "$local_size" =~ ^[0-9]+$ && "$local_size" -gt 0 && "$local_size" -le 1073741824 ]] || refuse 'Source exceeds 1 GiB safety limit'
    available="$(df -B1 --output=avail "$PARENT" | tail -n 1 | tr -d '[:space:]')" || refuse 'Cannot determine free disk space'
    [[ "$available" =~ ^[0-9]+$ && "$available" -ge $((local_size * 2 + 268435456)) ]] || refuse 'Not enough space for a retained backup with headroom'
    # mkdir is atomic and will fail if another invocation created the target.
    sudo -u postgres mkdir -m 0700 -- "$BACKUP" || refuse 'Cannot create private retained backup directory'
    sudo -u postgres touch -- "$INCOMPLETE"
    sudo -u postgres chmod 0600 -- "$INCOMPLETE"
    echo '========== CREATE PRIVATE RETAINED COPY FROM STOPPED SOURCE =========='
    sudo -u postgres cp -a --reflink=never -- "$SOURCE_DATA" "$BACKUP_DATA" || refuse 'Copy failed: backup remains incomplete, review manually'
    guard_source
    [[ "$(sudo -u postgres stat -c '%U:%a' "$BACKUP_DATA")" == postgres:700 ]] || refuse 'Copied data permission mismatch'
    source_digest="$(snapshot_digest "$SOURCE_DATA")" || refuse 'Source hash failed'
    backup_digest="$(snapshot_digest "$BACKUP_DATA")" || refuse 'Backup hash failed'
    [[ "$source_digest" =~ ^[a-f0-9]{64}$ && "$source_digest" == "$backup_digest" ]] || refuse 'Copied data differs from stopped source'
    source_file_bytes="$(regular_file_bytes "$SOURCE_DATA")" || refuse 'Source file byte count unavailable'
    backup_size="$(regular_file_bytes "$BACKUP_DATA")" || refuse 'Copied file byte count unavailable'
    [[ "$backup_size" == "$source_file_bytes" ]] || refuse 'Copied files differ in total bytes'
    # No manifest is trusted until the physical copy is complete and verified.
    printf 'pulse-metrics-5u2f2b-v1\nfile_bytes=%s\nfile_digest_sha256=%s\n' \
      "$source_file_bytes" "$source_digest" | sudo -u postgres bash -c 'cat > "$1"' bash "$MANIFEST"
    sudo -u postgres chmod 0600 -- "$MANIFEST"
    sudo -u postgres mv -- "$INCOMPLETE" "$COMPLETE"
    validate_backup
    guard_source
    echo '========== D15C-5U-2F2B RETAINED COLD SNAPSHOT: PASS =========='
    echo 'PASS: one retained, owner-only local copy, data digest and metadata verified'
    echo 'NO RESTORE FROM THIS RETAINED COPY TESTED | NO PITR | NO OFFSITE BACKUP | PUBLIC LAUNCH: NO_GO'
    ;;
esac
