#!/usr/bin/env bash
# D15C-5N: offline localhost-only preview contract tests. No DB or deployment.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ $# -eq 0 ]] || { echo 'REFUSE_D15C5N: unexpected arguments' >&2; exit 1; }
[[ "${NODE_ENV:-}" != 'production' ]] || { echo 'REFUSE_D15C5N: production mode' >&2; exit 1; }
for program in node npx; do
  command -v "$program" >/dev/null 2>&1 || { echo 'REFUSE_D15C5N: prerequisites missing' >&2; exit 1; }
done
node scripts/telemetry-maintenance/verify-history-contract-candidate.mjs
node scripts/monitoring-history/verify-5m-candidate.mjs
node scripts/monitoring-history/verify-5n-candidate.mjs
npx --no-install tsx --test \
  src/server/monitoring/history-preview-policy.test.ts \
  src/server/monitoring/history-preview-app.test.ts
echo '========== D15C-5N OFFLINE LOCAL HISTORY PREVIEW TESTS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | main server history API stays disabled'
