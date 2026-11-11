#!/usr/bin/env bash
# Phase 2E3C5C1: READ-ONLY adoption CANDIDATE check. No ledger backfill.
# The six legacy scripts were executed before receipt-based migrations existed;
# a reviewer must never label those historic events as fresh-replay receipts.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGCLUSTER || true
node scripts/migrations/verify-manifest.mjs
bash scripts/audit-migration-foundation.sh

echo '========== EXISTING INSTALLATION ADOPTION READINESS (READ ONLY) =========='
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics <<'SQL'
BEGIN READ ONLY;
DO $guard$
BEGIN
  IF current_database() <> 'pulse_metrics' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Local postgres audit role and database required';
  END IF;
  IF to_regnamespace('pulse_security_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'A privileged migration schema already exists; stop for independent review';
  END IF;
  IF (SELECT count(*) FROM public.__drizzle_migrations) <> 1 THEN
    RAISE EXCEPTION 'Existing Drizzle history differs; stop for review';
  END IF;
  RAISE NOTICE 'PASS: existing installation has original Drizzle ledger and no privileged replay receipts';
END;
$guard$;
COMMIT;
SQL
printf '%s\n' 'PASS: manifest and tested security baseline make this an adoption REVIEW candidate.'
printf '%s\n' 'NOTE: NO ledger or Drizzle entries were inserted; historical execution provenance is NOT asserted.'
