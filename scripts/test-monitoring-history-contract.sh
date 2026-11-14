#!/usr/bin/env bash
# D15C-5L offline-only candidate acceptance. Does not start services or connect to a database.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${NODE_ENV:-}" == production ]]; then
  echo 'REFUSE_D15C5L: production activation denied' >&2
  exit 1
fi
for forbidden in DATABASE_URL MIGRATION_DATABASE_URL DIRECT_URL PGHOST PGHOSTADDR \
  PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY DO_TOKEN RENDER_API_KEY \
  PULSE_D15C5L_DEPLOY PULSE_D15C5L_ENABLE; do
  if [[ -v $forbidden ]]; then
    echo "REFUSE_D15C5L: environment override denied: $forbidden" >&2
    exit 1
  fi
done

node scripts/telemetry-maintenance/verify-history-contract-candidate.mjs
node --import tsx --test \
  src/server/monitoring/history-contract.test.ts \
  src/server/monitoring/history-route.test.ts

echo '========== D15C-5L OFFLINE HISTORICAL READ CANDIDATE: TESTS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | no monitoring API mounted or database queried'
