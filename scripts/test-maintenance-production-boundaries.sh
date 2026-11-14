#!/usr/bin/env bash
# Pulse Metrics D15C-5J: review-only, no production access or mutations.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Deny any ambient live resource overrides before loading project sources.
case "${NODE_ENV:-}" in production) echo 'REFUSE_D15C5J: production environment denied' >&2; exit 1;; esac
for forbidden in DATABASE_URL MIGRATION_DATABASE_URL DIRECT_URL PGHOST PGHOSTADDR \
  PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE \
  PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGOPTIONS ALERT_WEBHOOK_URL \
  ALERT_DESTINATION_URL MAINTENANCE_DATABASE_URL PULSE_D15C5J_PRODUCTION \
  PULSE_D15C5J_DEPLOY PULSE_D15C5J_SEND_ALERT PULSE_D15C5J_OPERATOR_TOKEN \
  PULSE_D15C5J_CUSTODY_URL; do
  if [[ -v $forbidden ]]; then
    echo 'REFUSE_D15C5J: resource override denied' >&2; exit 1
  fi
done

node scripts/telemetry-maintenance/verify-durable-decision-candidate.mjs
node scripts/telemetry-maintenance/verify-custody-ack-candidate.mjs
node scripts/telemetry-maintenance/verify-production-boundary-candidate.mjs
node --test scripts/telemetry-maintenance/production-security-boundary.test.mjs

CLI=(node scripts/telemetry-maintenance/production-security-boundary-rehearsal.mjs)
EXPECTED='D15C5J_REVIEW {"event":"configuration_denied","authorized":false}'
for CASE in no_approval production pg_secret destination deploy arg; do
  if [[ "$CASE" == no_approval ]]; then
    if RESULT="$(PULSE_D15C5J_REVIEW_ONLY='' "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5J: missing review flag was accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == production ]]; then
    if RESULT="$(PULSE_D15C5J_REVIEW_ONLY=YES NODE_ENV=production "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5J: production flag was accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == pg_secret ]]; then
    if RESULT="$(PULSE_D15C5J_REVIEW_ONLY=YES PGPASSWORD='SYNTHETIC_TEST_ONLY' "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5J: database override was accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == destination ]]; then
    if RESULT="$(PULSE_D15C5J_REVIEW_ONLY=YES ALERT_DESTINATION_URL='https://example.invalid' "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5J: external destination was accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == deploy ]]; then
    if RESULT="$(PULSE_D15C5J_REVIEW_ONLY=YES PULSE_D15C5J_DEPLOY=YES "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5J: fake production approval was accepted' >&2; exit 1
    fi
  else
    if RESULT="$(PULSE_D15C5J_REVIEW_ONLY=YES "${CLI[@]}" --activate 2>&1)"; then
      echo 'REFUSE_D15C5J: extra arguments were accepted' >&2; exit 1
    fi
  fi
  if [[ "$RESULT" != "$EXPECTED" ]]; then
    echo 'REFUSE_D15C5J: denial not the exact sanitized result' >&2; exit 1
  fi
done
printf '%s\n' 'PASS: D15C-5J review guard rejects production, PG, destination and fake approval overrides'
PULSE_D15C5J_REVIEW_ONLY=YES "${CLI[@]}"
printf '%s\n' '========== D15C-5J PRODUCTION ARCHITECTURE REVIEW: ALL CHECKS PASSED =========='
printf '%s\n' 'PUBLIC LAUNCH: NO_GO | documentation and offline assertions only; no provider selected'
