#!/usr/bin/env bash
# Read-only existing-installation adoption evidence with pinned catalog fingerprint.
# NEVER records or backfills historical privileged migration receipts.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGCLUSTER || true
bash scripts/migrations/check-existing-adoption.sh
EXPECTED='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
TEMP_FILE="$(mktemp /tmp/pulse-adoption-catalog-XXXXXXXX)"
chmod 0600 "$TEMP_FILE"
trap 'rm -f -- "$TEMP_FILE"' EXIT
# The manifest reads only PostgreSQL catalog metadata, never customer rows.
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$TEMP_FILE"
ACTUAL="$(sha256sum "$TEMP_FILE" | cut -d' ' -f1)"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo 'ERROR: current database catalog has changed from the reviewed baseline.' >&2
  echo 'STOP: investigate the drift; do not adopt, backfill or replay privileged SQL.' >&2
  exit 1
fi
printf '%s\n' 'PASS: read-only adoption catalog fingerprint equals the independently reviewed baseline.'
printf '%s\n' 'PASS: existing original Drizzle ledger; no privileged receipts installed.'
printf '%s\n' 'NOTE: structural eligibility only; NOT historical provenance and NOT an adoption write.'
