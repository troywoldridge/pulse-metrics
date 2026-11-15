#!/usr/bin/env bash
# D15C-5Q: offline agent-discovery security and regression checks.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
refuse() { echo "REFUSE_D15C5Q: $*" >&2; exit 1; }
[[ $# -eq 0 ]] || refuse 'unexpected arguments'
[[ "${NODE_ENV:-}" != 'production' ]] || refuse 'production mode'
[[ -x node_modules/.bin/tsx ]] || refuse 'run npm ci first'
command -v timeout >/dev/null || refuse 'timeout missing'

bash scripts/test-monitoring-same-origin-preview.sh
node scripts/monitoring-history/verify-5q-candidate.mjs
node_modules/.bin/tsx --test \
  src/server/monitoring/agent-list-contract.test.ts \
  src/monitoring/preview-agent-client.test.ts \
  src/server/monitoring/agent-picker-preview-app.test.ts

# The new launcher must deny production and missing explicit additional opt-in.
set +e
NODE_ENV=production PULSE_HISTORY_PREVIEW=read-only PULSE_SAME_ORIGIN_PREVIEW=enabled \
 PULSE_AGENT_PICKER_PREVIEW=enabled timeout 10s node_modules/.bin/tsx \
 scripts/monitoring-history/start-agent-picker-preview.ts >/dev/null 2>&1
production_status=$?
NODE_ENV=development PULSE_HISTORY_PREVIEW=read-only PULSE_SAME_ORIGIN_PREVIEW=enabled \
 PULSE_AGENT_PICKER_PREVIEW=disabled timeout 10s node_modules/.bin/tsx \
 scripts/monitoring-history/start-agent-picker-preview.ts >/dev/null 2>&1
missing_status=$?
set -e
[[ "$production_status" -eq 1 ]] || refuse "production did not fail closed ($production_status)"
[[ "$missing_status" -eq 1 ]] || refuse "missing opt-in did not fail closed ($missing_status)"
echo '========== D15C-5Q LOCAL AGENT PICKER CANDIDATE: OFFLINE CHECKS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | no agent enrollment or production mount authorized'
