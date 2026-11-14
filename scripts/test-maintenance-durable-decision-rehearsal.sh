#!/usr/bin/env bash
# Pulse Metrics D15C-5I OFFLINE only. Never connects to PostgreSQL or a real
# remote endpoint; all identities and evidence are ephemeral synthetic fixtures.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node scripts/telemetry-maintenance/verify-custody-ack-candidate.mjs
node scripts/telemetry-maintenance/verify-recovery-candidate.mjs
node scripts/telemetry-maintenance/verify-isolated-alert-candidate.mjs
node scripts/telemetry-maintenance/verify-operator-alert-candidate.mjs
node scripts/telemetry-maintenance/verify-durable-decision-candidate.mjs
node --test scripts/telemetry-maintenance/durable-decision-ledger.test.mjs
CLI=(node scripts/telemetry-maintenance/durable-decision-rehearsal.mjs)
EXPECTED='D15C5I_TEST {"event":"configuration_denied","live":false}'
for CASE in no_approval production database password delivery external operator arguments; do
  case "$CASE" in
    no_approval)
      if RESULT="$(PULSE_D15C5I_DISPOSABLE_ONLY='' NODE_ENV=test "${CLI[@]}" 2>&1)"; then
        echo 'REFUSE_D15C5I: missing approval accepted' >&2; exit 1; fi;;
    production)
      if RESULT="$(PULSE_D15C5I_DISPOSABLE_ONLY=YES NODE_ENV=production "${CLI[@]}" 2>&1)"; then
        echo 'REFUSE_D15C5I: production mode accepted' >&2; exit 1; fi;;
    database)
      if RESULT="$(PULSE_D15C5I_DISPOSABLE_ONLY=YES NODE_ENV=test DATABASE_URL='postgres://synthetic' "${CLI[@]}" 2>&1)"; then
        echo 'REFUSE_D15C5I: database override accepted' >&2; exit 1; fi;;
    password)
      if RESULT="$(PULSE_D15C5I_DISPOSABLE_ONLY=YES NODE_ENV=test PGPASSWORD='SYNTHETIC_ONLY' "${CLI[@]}" 2>&1)"; then
        echo 'REFUSE_D15C5I: password override accepted' >&2; exit 1; fi;;
    delivery)
      if RESULT="$(PULSE_D15C5I_DISPOSABLE_ONLY=YES NODE_ENV=test PULSE_D15C5I_DELIVERY_URL='http://invalid.example' "${CLI[@]}" 2>&1)"; then
        echo 'REFUSE_D15C5I: outbound destination accepted' >&2; exit 1; fi;;
    external)
      if RESULT="$(PULSE_D15C5I_DISPOSABLE_ONLY=YES NODE_ENV=test PULSE_D15C5I_EXTERNAL_CUSTODY='YES' "${CLI[@]}" 2>&1)"; then
        echo 'REFUSE_D15C5I: external custody claim accepted' >&2; exit 1; fi;;
    operator)
      if RESULT="$(PULSE_D15C5I_DISPOSABLE_ONLY=YES NODE_ENV=test PULSE_D15C5I_LIVE_OPERATOR='YES' "${CLI[@]}" 2>&1)"; then
        echo 'REFUSE_D15C5I: live operator accepted' >&2; exit 1; fi;;
    arguments)
      if RESULT="$(PULSE_D15C5I_DISPOSABLE_ONLY=YES NODE_ENV=test "${CLI[@]}" --unsafe 2>&1)"; then
        echo 'REFUSE_D15C5I: command-line override accepted' >&2; exit 1; fi;;
  esac
  [[ "$RESULT" == "$EXPECTED" ]] || {
    echo 'REFUSE_D15C5I: unsafe configuration did not produce exact sanitized denial' >&2
    exit 1
  }
done
printf '%s\n' 'PASS: D15C-5I unsafe production, database, delivery and operator settings denied'
PULSE_D15C5I_DISPOSABLE_ONLY=YES NODE_ENV=test "${CLI[@]}"
printf '%s\n' '========== D15C-5I OFFLINE REPLAY/CUSTODY REVIEW: ALL CHECKS PASSED =========='
printf '%s\n' 'PUBLIC LAUNCH: NO_GO | no production operator, customer DB, alerts or scheduler'
