#!/usr/bin/env bash
# D15C-5T: temporary TLS trust only for one Node test subprocess.
# This file is never a standalone database initializer or production launcher.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
refuse() { printf 'REFUSE_D15C5T_TLS: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Linux ]] || refuse 'Linux required'
[[ "$PWD" == "$ROOT" ]] || refuse 'unexpected project root'
[[ "${PULSE_D15C5T_ONLY:-}" == YES && "${PULSE_D15C4_DISPOSABLE_ONLY:-}" == YES ]] || refuse 'disposable admission missing'
[[ "${NODE_ENV:-development}" != production ]] || refuse 'production refused'
[[ -z "${NODE_OPTIONS:-}" && -z "${NODE_EXTRA_CA_CERTS:-}" ]] || refuse 'unexpected Node startup or trust settings'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 ]] || refuse 'TLS verification disabled'
[[ "${PULSE_D15C4_SOCKET:-}" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$ ]] || refuse 'socket not disposable'
[[ "${PULSE_D15C4_DATA:-}" == "${PULSE_D15C4_SOCKET%/socket}/data" ]] || refuse 'data directory mismatch'
[[ -f "${PULSE_D15C4_SOCKET%/socket}/.pulse-telemetry-agent-quota-marker" ]] || refuse 'disposable marker missing'
for cmd in mktemp openssl node; do command -v "$cmd" >/dev/null || refuse "missing $cmd"; done

BASE="$(mktemp -d /tmp/pulse-d15c5t-XXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-d15c5t-[A-Za-z0-9]{6}$ ]] || refuse 'temporary CA path invalid'
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "${BASE:-}" && "$BASE" =~ ^/tmp/pulse-d15c5t-[A-Za-z0-9]{6}$ &&
        -d "$BASE" && ! -L "$BASE" && -O "$BASE" ]]; then
    rm -rf -- "$BASE" || status=1
  else
    echo 'CRITICAL: could not safely remove test CA directory' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$BASE/ca.key" -out "$BASE/ca.pem" \
  -subj '/CN=Pulse Metrics disposable 5T CA' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$BASE/tls.key" -out "$BASE/tls.csr" \
  -subj '/CN=127.0.0.1' >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$BASE/tls.ext"
openssl x509 -req -in "$BASE/tls.csr" -CA "$BASE/ca.pem" \
  -CAkey "$BASE/ca.key" -CAcreateserial -out "$BASE/tls.pem" \
  -days 1 -sha256 -extfile "$BASE/tls.ext" >/dev/null 2>&1

NODE_ENV=development \
NODE_EXTRA_CA_CERTS="$BASE/ca.pem" \
PULSE_D15C5T_CA="$BASE/ca.pem" \
PULSE_D15C5T_TLS_KEY="$BASE/tls.key" \
PULSE_D15C5T_TLS_CERT="$BASE/tls.pem" \
  node --import tsx scripts/telemetry-https/verify-sender-to-postgres.mjs
