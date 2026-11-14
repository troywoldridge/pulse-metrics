#!/usr/bin/env bash
# D15C-5H review-only, OFFLINE. No sudo, DB, external network or live scheduler.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node scripts/telemetry-maintenance/verify-recovery-candidate.mjs
node scripts/telemetry-maintenance/verify-isolated-alert-candidate.mjs
node scripts/telemetry-maintenance/verify-operator-alert-candidate.mjs
node scripts/telemetry-maintenance/verify-custody-ack-candidate.mjs
node --test scripts/telemetry-maintenance/custody-ack-contract.test.mjs

CLI=(node scripts/telemetry-maintenance/custody-ack-rehearsal.mjs)
EXPECTED='D15C5H_TEST {"event":"configuration_denied","live":false}'
for CASE in missing_approval production pg_password database_url external_custody live_operator; do
  if [[ "$CASE" == missing_approval ]]; then
    if RESULT="$(PULSE_D15C5H_DISPOSABLE_ONLY='' "${CLI[@]}")"; then
      echo 'REFUSE_D15C5H: missing approval accepted' >&2; exit 1; fi
  elif [[ "$CASE" == production ]]; then
    if RESULT="$(PULSE_D15C5H_DISPOSABLE_ONLY=YES NODE_ENV=production "${CLI[@]}")"; then
      echo 'REFUSE_D15C5H: production accepted' >&2; exit 1; fi
  elif [[ "$CASE" == pg_password ]]; then
    if RESULT="$(PULSE_D15C5H_DISPOSABLE_ONLY=YES PGPASSWORD='TEST_ONLY_DO_NOT_PRINT' "${CLI[@]}")"; then
      echo 'REFUSE_D15C5H: PG override accepted' >&2; exit 1; fi
  elif [[ "$CASE" == database_url ]]; then
    if RESULT="$(PULSE_D15C5H_DISPOSABLE_ONLY=YES DATABASE_URL='test-do-not-print' "${CLI[@]}")"; then
      echo 'REFUSE_D15C5H: database URL accepted' >&2; exit 1; fi
  elif [[ "$CASE" == external_custody ]]; then
    if RESULT="$(PULSE_D15C5H_DISPOSABLE_ONLY=YES PULSE_D15C5H_EXTERNAL_CUSTODY='enabled' "${CLI[@]}")"; then
      echo 'REFUSE_D15C5H: external custody accepted' >&2; exit 1; fi
  else
    if RESULT="$(PULSE_D15C5H_DISPOSABLE_ONLY=YES PULSE_D15C5H_LIVE_OPERATOR='enabled' "${CLI[@]}")"; then
      echo 'REFUSE_D15C5H: live operator accepted' >&2; exit 1; fi
  fi
  if [[ "$RESULT" != "$EXPECTED" ]]; then
    echo 'REFUSE_D15C5H: unsafe configuration did not produce exact sanitized denial' >&2
    exit 1
  fi
done
printf '%s\n' 'PASS: D15C-5H unsafe production, credential, identity and custody configuration denied'
PULSE_D15C5H_DISPOSABLE_ONLY=YES "${CLI[@]}"
printf '%s\n' '========== D15C-5H OFFLINE SIGNED CUSTODY REVIEW: ALL CHECKS PASSED =========='
printf '%s\n' 'PUBLIC LAUNCH: NO_GO | test signatures only; no production operator or custody'
