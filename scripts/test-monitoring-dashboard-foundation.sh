#!/usr/bin/env bash
# D15C-5O: offline dashboard foundation tests. Never connects to PostgreSQL.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ $# -ne 0 || "${NODE_ENV:-}" == 'production' ]]; then
  echo 'REFUSE_D15C5O: unexpected arguments or production mode' >&2
  exit 1
fi
for bin in node git; do
  command -v "$bin" >/dev/null 2>&1 || { echo "REFUSE_D15C5O: missing $bin" >&2; exit 1; }
done
[[ -x node_modules/.bin/tsx ]] || { echo 'REFUSE_D15C5O: local tsx dependency missing' >&2; exit 1; }

node scripts/telemetry-maintenance/verify-history-contract-candidate.mjs
node scripts/monitoring-history/verify-5m-candidate.mjs
node scripts/monitoring-history/verify-5n-candidate.mjs
node scripts/monitoring-history/verify-5o-candidate.mjs

node_modules/.bin/tsx --test \
  src/monitoring/history-client.test.ts \
  src/monitoring/history-state.test.ts \
  src/components/RealHistoryPanel.test.tsx

echo '========== D15C-5O OFFLINE DASHBOARD FOUNDATION: TESTS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | no main monitoring endpoint or UI mount'
