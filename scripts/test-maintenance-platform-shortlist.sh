#!/usr/bin/env bash
# Pulse Metrics D15C-5K: self-host and vendor assessment; no live provider, DB or deployment access.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${NODE_ENV:-}" == production ]]; then
  echo 'REFUSE_D15C5K: production environment denied' >&2; exit 1
fi
for forbidden in DATABASE_URL MIGRATION_DATABASE_URL DIRECT_URL PGHOST PGHOSTADDR \
  PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE \
  PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGOPTIONS AWS_ACCESS_KEY_ID \
  AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE DIGITALOCEAN_ACCESS_TOKEN \
  DO_TOKEN RENDER_API_KEY S3_BUCKET KMS_KEY_ID ALERT_WEBHOOK_URL \
  ALERT_DESTINATION_URL MAINTENANCE_DATABASE_URL PULSE_D15C5K_DEPLOY \
  PULSE_D15C5K_APPROVED PULSE_D15C5K_PRODUCTION PULSE_D15C5K_PURCHASE PULSE_D15C5K_SELFHOST_DEPLOY; do
  if [[ -v $forbidden ]]; then
    echo 'REFUSE_D15C5K: cloud/DB/resource override denied' >&2; exit 1
  fi
done

node scripts/telemetry-maintenance/verify-production-boundary-candidate.mjs
node scripts/telemetry-maintenance/verify-platform-shortlist-candidate.mjs
node --test scripts/telemetry-maintenance/platform-shortlist-contract.test.mjs

CLI=(node scripts/telemetry-maintenance/platform-shortlist-rehearsal.mjs)
EXPECTED='D15C5K_REVIEW {"event":"configuration_denied","authorized":false}'
for CASE in no_review production pg_secret aws_secret do_token deploy arg; do
  if [[ "$CASE" == no_review ]]; then
    if RESULT="$(PULSE_D15C5K_REVIEW_ONLY='' "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5K: missing review flag accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == production ]]; then
    if RESULT="$(PULSE_D15C5K_REVIEW_ONLY=YES NODE_ENV=production "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5K: production accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == pg_secret ]]; then
    if RESULT="$(PULSE_D15C5K_REVIEW_ONLY=YES PGPASSWORD='SYNTHETIC' "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5K: database secret accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == aws_secret ]]; then
    if RESULT="$(PULSE_D15C5K_REVIEW_ONLY=YES AWS_ACCESS_KEY_ID='SYNTHETIC' "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5K: cloud secret accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == do_token ]]; then
    if RESULT="$(PULSE_D15C5K_REVIEW_ONLY=YES DIGITALOCEAN_ACCESS_TOKEN='SYNTHETIC' "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5K: provider secret accepted' >&2; exit 1
    fi
  elif [[ "$CASE" == deploy ]]; then
    if RESULT="$(PULSE_D15C5K_REVIEW_ONLY=YES PULSE_D15C5K_DEPLOY=YES "${CLI[@]}" 2>&1)"; then
      echo 'REFUSE_D15C5K: deployment accepted' >&2; exit 1
    fi
  else
    if RESULT="$(PULSE_D15C5K_REVIEW_ONLY=YES "${CLI[@]}" --deploy 2>&1)"; then
      echo 'REFUSE_D15C5K: command args accepted' >&2; exit 1
    fi
  fi
  if [[ "$RESULT" != "$EXPECTED" ]]; then
    echo 'REFUSE_D15C5K: unexpected rejection output' >&2; exit 1
  fi
done
printf '%s\n' 'PASS: D15C-5K seven unsafe-start scenarios fail closed before provider access'
PULSE_D15C5K_REVIEW_ONLY=YES "${CLI[@]}"
printf '%s\n' '========== D15C-5K OFFLINE SELF-HOST SHORTLIST: ALL CHECKS PASSED =========='
printf '%s\n' 'PUBLIC LAUNCH: NO_GO | only external due diligence may unlock future decisions'
