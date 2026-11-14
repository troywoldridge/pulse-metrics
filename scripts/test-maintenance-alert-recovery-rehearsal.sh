#!/usr/bin/env bash
# D15C-5G offline snapshot/recovery: NO DB, HTTP, real identity or scheduler.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node scripts/telemetry-maintenance/verify-audit-candidate.mjs
node scripts/telemetry-maintenance/verify-operator-alert-candidate.mjs
node scripts/telemetry-maintenance/verify-isolated-alert-candidate.mjs
node scripts/telemetry-maintenance/verify-recovery-candidate.mjs
node --test scripts/telemetry-maintenance/alert-recovery-anchor.test.mjs

CLI=(node scripts/telemetry-maintenance/alert-recovery-rehearsal.mjs)
EXPECTED='D15C5G_TEST {"event":"configuration_denied","live":false}'
for CASE in missing_approval production pg_password pg_host database_url external_delivery external_witness claimed_operator extra_args; do
  RESULT=''
  if [[ "$CASE" == missing_approval ]]; then
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY='' "${CLI[@]}")"; then exit 1; fi
  elif [[ "$CASE" == production ]]; then
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY=YES NODE_ENV=production "${CLI[@]}")"; then exit 1; fi
  elif [[ "$CASE" == pg_password ]]; then
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY=YES PGPASSWORD=TEST_SENTINEL "${CLI[@]}")"; then exit 1; fi
  elif [[ "$CASE" == pg_host ]]; then
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY=YES PGHOST=localhost "${CLI[@]}")"; then exit 1; fi
  elif [[ "$CASE" == database_url ]]; then
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY=YES DATABASE_URL=postgres://example.invalid "${CLI[@]}")"; then exit 1; fi
  elif [[ "$CASE" == external_delivery ]]; then
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY=YES PULSE_D15C5G_DELIVERY_URL=https://example.invalid "${CLI[@]}")"; then exit 1; fi
  elif [[ "$CASE" == external_witness ]]; then
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY=YES PULSE_D15C5G_ANCHOR_URL=https://example.invalid "${CLI[@]}")"; then exit 1; fi
  elif [[ "$CASE" == claimed_operator ]]; then
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY=YES PULSE_D15C5G_OPERATOR=pretend "${CLI[@]}")"; then exit 1; fi
  else
    if RESULT="$(PULSE_D15C5G_DISPOSABLE_ONLY=YES "${CLI[@]}" unexpected)"; then exit 1; fi
  fi
  [[ "$RESULT" == "$EXPECTED" ]] || {
    echo 'REFUSE_D15C5G: unsafe configuration did not produce exact refusal' >&2
    exit 1
  }
done
printf '%s\n' 'PASS: D15C-5G all unsafe configurations denied before file access'
PULSE_D15C5G_DISPOSABLE_ONLY=YES timeout --signal=TERM --kill-after=5s 25s "${CLI[@]}"
printf '%s\n' '========== D15C-5G OFFLINE RECOVERY REVIEW: ALL CHECKS PASSED =========='
printf '%s\n' 'PUBLIC LAUNCH: NO_GO | no real custody, operators, recipients or scheduled work'
