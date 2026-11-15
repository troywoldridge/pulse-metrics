#!/usr/bin/env bash
# D15C-5P: offline source and HTTP safety verification; no database writes.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

refuse() { echo "REFUSE_D15C5P: $*" >&2; exit 1; }
[[ $# -eq 0 ]] || refuse 'unexpected arguments'
[[ "${NODE_ENV:-}" != 'production' ]] || refuse 'production environment'
for bin in node git timeout; do command -v "$bin" >/dev/null 2>&1 || refuse "missing $bin"; done
[[ -x node_modules/.bin/tsx ]] || refuse 'missing local tsx binary; run npm ci on adap'

node scripts/telemetry-maintenance/verify-history-contract-candidate.mjs
node scripts/monitoring-history/verify-5m-candidate.mjs
node scripts/monitoring-history/verify-5n-candidate.mjs
node scripts/monitoring-history/verify-5o-candidate.mjs
node scripts/monitoring-history/verify-5p-candidate.mjs

node_modules/.bin/tsx --test \
  src/server/monitoring/same-origin-preview-app.test.ts \
  src/monitoring/preview-organization-client.test.ts

# Fail closed BEFORE the launcher can establish a listener, even on localhost.
# timeout=124 is a failure, not a successful denial.
set +e
NODE_ENV=production PULSE_HISTORY_PREVIEW=read-only PULSE_SAME_ORIGIN_PREVIEW=enabled \
  timeout 10s node_modules/.bin/tsx scripts/monitoring-history/start-same-origin-preview.ts >/dev/null 2>&1
production_status=$?
NODE_ENV=development PULSE_HISTORY_PREVIEW=read-only PULSE_SAME_ORIGIN_PREVIEW=disabled \
  timeout 10s node_modules/.bin/tsx scripts/monitoring-history/start-same-origin-preview.ts >/dev/null 2>&1
missing_optin_status=$?
set -e
[[ "$production_status" -eq 1 ]] || refuse "production startup did not fail closed (status $production_status)"
[[ "$missing_optin_status" -eq 1 ]] || refuse "missing opt-in did not fail closed (status $missing_optin_status)"

echo '========== D15C-5P OFFLINE SAME-ORIGIN PREVIEW: TESTS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | main server remains unchanged and closed'
