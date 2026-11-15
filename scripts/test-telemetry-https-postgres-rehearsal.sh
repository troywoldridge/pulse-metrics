#!/usr/bin/env bash
# Pulse Metrics D15C-5T — integrate genuine Linux telemetry + verified HTTPS
# with the existing FULLY DISPOSABLE PostgreSQL/agent quota rehearsal.
# Never alters the original rehearsal, server.ts, roles, migrations or main DB.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
refuse() { printf 'REFUSE_D15C5T: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Linux ]] || refuse 'Linux required'
[[ "${NODE_ENV:-development}" != production ]] || refuse 'production refused'
[[ -z "${NODE_OPTIONS:-}" ]] || refuse 'NODE_OPTIONS must be absent; invoke with env -u NODE_OPTIONS'
[[ -z "${NODE_EXTRA_CA_CERTS:-}" ]] || refuse 'preexisting NODE_EXTRA_CA_CERTS refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 ]] || refuse 'TLS verification must remain enabled'
for tool in git cmp python3 mktemp bash node openssl timeout sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || refuse "missing prerequisite: $tool"
done

ORIGINAL='scripts/test-telemetry-agent-quota-http-rehearsal.sh'
REVIEWED_REF='78e6640'
[[ -f "$ORIGINAL" && ! -L "$ORIGINAL" ]] || refuse 'baseline rehearsal source missing or linked'
[[ -f scripts/telemetry-https/verify-sender-to-postgres.mjs ]] || refuse '5T integration module missing'
[[ -f scripts/telemetry-https/run-postgres-https-subtest.sh ]] || refuse '5T certificate launcher missing'
[[ -f src/agent/transport/https-telemetry-sender.ts ]] || refuse '5R sender missing'
[[ -f scripts/telemetry-https/verify-sender-to-ingress.mjs ]] || refuse '5S integration source missing'

# A committed, reviewed baseline is the authority. Refuse any working copy drift.
git cat-file -e "${REVIEWED_REF}:${ORIGINAL}" 2>/dev/null || refuse 'pinned baseline commit unavailable'
cmp -s "$ORIGINAL" <(git show "${REVIEWED_REF}:${ORIGINAL}") ||
  refuse 'original database rehearsal differs from the reviewed commit'

# Place generated full-file copy in scripts/, so its existing dirname-based
# project root logic continues to work without editing the original.
TMP="$(mktemp "$ROOT/scripts/.pulse-d15c5t-XXXXXXXX.sh")"
[[ "$TMP" =~ ^${ROOT}/scripts/\.pulse-d15c5t-[A-Za-z0-9]{8}[.]sh$ ]] ||
  refuse 'unexpected generated test-copy path'
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "${TMP:-}" && "$TMP" =~ ^${ROOT}/scripts/\.pulse-d15c5t-[A-Za-z0-9]{8}[.]sh$ &&
        -f "$TMP" && ! -L "$TMP" && -O "$TMP" ]]; then
    rm -f -- "$TMP" || status=1
  else
    echo 'CRITICAL: cannot safely remove generated test-only rehearsal copy' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Fully rewrite a temporary copy, inserting one isolated test *after* the
# proven 4E database audit. Original source stays byte-for-byte unchanged.
python3 - "$ORIGINAL" "$TMP" <<'PY'
from pathlib import Path
import sys
original, destination = map(Path, sys.argv[1:3])
source = original.read_text(encoding='utf-8')
anchor = "echo '========== D15C-4E COMBINED REHEARSAL: ALL CHECKS PASSED =========='"
if source.count(anchor) != 1 or not source.endswith("PUBLIC LAUNCH: NO_GO | isolated, unmounted test only'\n"):
    raise SystemExit('REFUSE_D15C5T: baseline terminal boundary changed')
insertion = '''echo '========== D15C-5T VERIFIED HTTPS -> DISPOSABLE POSTGRESQL =========='
PULSE_D15C4_DISPOSABLE_ONLY=YES \\
PULSE_D15C4_SOCKET="$SOCKET" \\
PULSE_D15C4_DATA="$DATA" \\
PULSE_D15C4_ORG_A="$ORG_A" \\
PULSE_D15C4_ORG_B="$ORG_B" \\
PULSE_D15C5T_ONLY=YES \\
  timeout --signal=TERM --kill-after=10s 180s \\
  bash scripts/telemetry-https/run-postgres-https-subtest.sh

psql_admin pulse_metrics -q <<'SQLVERIFY5T'
DO $verify$
DECLARE
  v_total bigint;
  v_receipts bigint;
  v_real bigint;
  v_tenants bigint;
  v_agents bigint;
  v_shared_ids bigint;
BEGIN
  SELECT count(*) INTO v_total FROM public.telemetry_samples;
  SELECT count(*) INTO v_receipts FROM pulse_telemetry_ingestion.submissions;
  IF v_total <> 246 OR v_receipts <> 246 THEN
    RAISE EXCEPTION 'D15C5T wrong persisted sample/submission count';
  END IF;
  SELECT count(*),count(DISTINCT organization_id),count(DISTINCT agent_id)
    INTO v_real,v_tenants,v_agents FROM public.telemetry_samples
    WHERE metrics ? 'memory.total_bytes';
  IF v_real <> 2 OR v_tenants <> 2 OR v_agents <> 2 THEN
    RAISE EXCEPTION 'D15C5T genuine samples not bound to two isolated tenants';
  END IF;
  SELECT count(*) INTO v_shared_ids FROM (
    SELECT submission_id FROM pulse_telemetry_ingestion.submissions
    GROUP BY submission_id HAVING count(DISTINCT organization_id) > 1
  ) shared;
  IF v_shared_ids < 1 THEN
    RAISE EXCEPTION 'D15C5T cross-tenant independent submission identity missing';
  END IF;
  RAISE NOTICE 'PASS: 246 durable rows; 2 genuine Linux telemetry rows isolated by 2 agents/organizations';
END;
$verify$;
SQLVERIFY5T
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql

echo '========== D15C-5T VERIFIED FULL PIPELINE: ALL CHECKS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | test-only certificates, synthetic identities, disposable PostgreSQL'

'''
destination.write_text(source.replace(anchor, insertion + anchor), encoding='utf-8')
PY

[[ -s "$TMP" ]] || refuse 'generated test-only script empty'
bash -n "$TMP" || refuse 'generated script syntax invalid'
echo 'PASS: original committed source unchanged; generated disposable full-file runner validated'
echo '========== START D15C-5T DISPOSABLE REHEARSAL =========='
bash "$TMP"
echo '========== D15C-5T LAUNCHER COMPLETE =========='
