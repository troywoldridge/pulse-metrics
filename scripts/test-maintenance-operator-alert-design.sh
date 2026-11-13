#!/usr/bin/env bash
# Pulse Metrics D15C-5E — offline review-only security-contract checks.
# No sudo, PostgreSQL service, migration, operator provisioning, API, HTTP,
# cron, alert destination or production environment may be touched.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node scripts/telemetry-maintenance/verify-audit-candidate.mjs
node scripts/telemetry-maintenance/verify-operator-alert-candidate.mjs
node --test scripts/telemetry-maintenance/operator-alert-contract.test.mjs

CLI=(node scripts/telemetry-maintenance/operator-alert-dry-run.mjs)
EXPECTED='D15C5E_REVIEW {"event":"configuration_denied","live":false}'
# Every denial must be nonzero with EXACTLY one sanitized fixed output line.
for CASE in missing_approval production_mode pg_password; do
  if [[ "$CASE" == 'missing_approval' ]]; then
    if RESULT="$(PULSE_D15C5E_DISPOSABLE_ONLY='' "${CLI[@]}")"; then
      echo 'REFUSE_D15C5E: missing approval unexpectedly accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == 'production_mode' ]]; then
    if RESULT="$(PULSE_D15C5E_DISPOSABLE_ONLY=YES NODE_ENV=production "${CLI[@]}")"; then
      echo 'REFUSE_D15C5E: production mode unexpectedly accepted' >&2; exit 1
    fi
  else
    if RESULT="$(PULSE_D15C5E_DISPOSABLE_ONLY=YES PGPASSWORD='TEST_ONLY_SAMPLE' "${CLI[@]}")"; then
      echo 'REFUSE_D15C5E: password override unexpectedly accepted' >&2; exit 1
    fi
  fi
  [[ "$RESULT" == "$EXPECTED" ]] || {
    echo 'REFUSE_D15C5E: unsafe configuration did not fail with exact safe output' >&2
    exit 1
  }
done
printf '%s\n' 'PASS: D15C-5E missing approval, production mode and libpq password refused'
PULSE_D15C5E_DISPOSABLE_ONLY=YES "${CLI[@]}"
printf '%s\n' '========== D15C-5E OFFLINE DESIGN REVIEW: ALL CHECKS PASSED =========='
printf '%s\n' 'PUBLIC LAUNCH: NO_GO | review only; no permissions, webhooks, email or scheduler'
