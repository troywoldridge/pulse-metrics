#!/usr/bin/env bash
# Pulse Metrics D15C-5F: REVIEW-ONLY ephemeral HTTP loopback fake delivery.
# No real recipients, database connections, cron, grants or production operator.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node scripts/telemetry-maintenance/verify-audit-candidate.mjs
node scripts/telemetry-maintenance/verify-operator-alert-candidate.mjs
node scripts/telemetry-maintenance/verify-isolated-alert-candidate.mjs
node --test \
  scripts/telemetry-maintenance/isolated-alert-handoff.test.mjs

CLI=(node scripts/telemetry-maintenance/isolated-alert-rehearsal.mjs)
EXPECTED='D15C5F_TEST {"event":"configuration_denied","live":false}'
for CASE in missing_approval production_mode pg_password external_url extra_args; do
  if [[ "$CASE" == missing_approval ]]; then
    if RESULT="$(PULSE_D15C5F_DISPOSABLE_ONLY='' "${CLI[@]}")"; then
      echo 'REFUSE_D15C5F: missing approval unexpectedly accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == production_mode ]]; then
    if RESULT="$(PULSE_D15C5F_DISPOSABLE_ONLY=YES NODE_ENV=production "${CLI[@]}")"; then
      echo 'REFUSE_D15C5F: production mode unexpectedly accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == pg_password ]]; then
    if RESULT="$(PULSE_D15C5F_DISPOSABLE_ONLY=YES PGPASSWORD=TEST_ONLY_SENTINEL "${CLI[@]}")"; then
      echo 'REFUSE_D15C5F: PostgreSQL override unexpectedly accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == external_url ]]; then
    if RESULT="$(PULSE_D15C5F_DISPOSABLE_ONLY=YES PULSE_D15C5F_DELIVERY_URL=https://example.invalid "${CLI[@]}")"; then
      echo 'REFUSE_D15C5F: external URL unexpectedly accepted' >&2; exit 1
    fi
  else
    if RESULT="$(PULSE_D15C5F_DISPOSABLE_ONLY=YES "${CLI[@]}" extra)"; then
      echo 'REFUSE_D15C5F: extra args unexpectedly accepted' >&2; exit 1
    fi
  fi
  [[ "$RESULT" == "$EXPECTED" ]] || {
    echo 'REFUSE_D15C5F: refusal output not exactly sanitized' >&2; exit 1
  }
done
echo 'PASS: D15C-5F missing approval, production, PG override, and external URL refused'

PULSE_D15C5F_DISPOSABLE_ONLY=YES \
  timeout --signal=TERM --kill-after=5s 35s "${CLI[@]}"
echo '========== D15C-5F REVIEW-ONLY LOOPBACK REHEARSAL: ALL CHECKS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | no operator, scheduler, production alerts or external destinations'
