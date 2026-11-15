#!/usr/bin/env bash
# Pulse Metrics D15C-5S: test-only verified HTTPS sender -> isolated ingress.
# Does NOT use .env, PostgreSQL, production routes, real credentials or customer data.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
fail() { printf 'REFUSE_D15C5S: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Linux ]] || fail 'Linux is required'
[[ "${NODE_ENV:-development}" != production ]] || fail 'Production refused'
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != 0 ]] || fail 'Disabled TLS certificate verification refused'
[[ -z "${NODE_OPTIONS:-}" ]] || fail 'NODE_OPTIONS must be absent for the isolated test'
for bin in node openssl mktemp rm; do
  command -v "$bin" >/dev/null 2>&1 || fail "Missing prerequisite: $bin"
done
[[ -f src/agent/transport/https-telemetry-sender.ts ]] || fail 'D15C-5R sender not installed'
[[ -f src/server/security/telemetry-ingress.ts ]] || fail 'Expected ingress candidate missing'
[[ -f src/server/telemetry/http-ingestion.ts ]] || fail 'Expected HTTP candidate missing'

BASE="$(mktemp -d /tmp/pulse-d15c5s-XXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-d15c5s-[A-Za-z0-9]{6}$ ]] || fail 'Unexpected temporary directory'
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "${BASE:-}" && "$BASE" =~ ^/tmp/pulse-d15c5s-[A-Za-z0-9]{6}$ && -d "$BASE" && ! -L "$BASE" && -O "$BASE" ]]; then
    rm -rf -- "$BASE" || code=1
  else
    printf 'CRITICAL: Test certificate directory could not be safely removed\n' >&2
    code=1
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Create an ephemeral CA and two certificates signed by it: correct IP and wrong host.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$BASE/ca.key" -out "$BASE/ca.pem" \
  -subj '/CN=Pulse Metrics disposable local CA' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$BASE/ok.key" -out "$BASE/ok.csr" \
  -subj '/CN=127.0.0.1' >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$BASE/ok.ext"
openssl x509 -req -in "$BASE/ok.csr" -CA "$BASE/ca.pem" \
  -CAkey "$BASE/ca.key" -CAcreateserial -out "$BASE/ok.pem" \
  -days 1 -sha256 -extfile "$BASE/ok.ext" >/dev/null 2>&1

openssl req -newkey rsa:2048 -nodes \
  -keyout "$BASE/wrong.key" -out "$BASE/wrong.csr" \
  -subj '/CN=wrong-host.invalid' >/dev/null 2>&1
printf 'subjectAltName=DNS:wrong-host.invalid\nextendedKeyUsage=serverAuth\n' > "$BASE/wrong.ext"
openssl x509 -req -in "$BASE/wrong.csr" -CA "$BASE/ca.pem" \
  -CAkey "$BASE/ca.key" -CAcreateserial -out "$BASE/wrong.pem" \
  -days 1 -sha256 -extfile "$BASE/wrong.ext" >/dev/null 2>&1

# Independently self-signed certificate: not trusted by the disposable CA.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$BASE/bad.key" -out "$BASE/bad.pem" \
  -subj '/CN=127.0.0.1' \
  -addext 'subjectAltName=IP:127.0.0.1' >/dev/null 2>&1

# NODE_EXTRA_CA_CERTS is read when Node starts. Never alter production trust.
NODE_ENV=development \
NODE_EXTRA_CA_CERTS="$BASE/ca.pem" \
PULSE_D15C5S_CA="$BASE/ca.pem" \
PULSE_D15C5S_ONLY=YES \
PULSE_D15C5S_OK_KEY="$BASE/ok.key" \
PULSE_D15C5S_OK_CERT="$BASE/ok.pem" \
PULSE_D15C5S_BAD_KEY="$BASE/bad.key" \
PULSE_D15C5S_BAD_CERT="$BASE/bad.pem" \
PULSE_D15C5S_WRONG_KEY="$BASE/wrong.key" \
PULSE_D15C5S_WRONG_CERT="$BASE/wrong.pem" \
node --import tsx scripts/telemetry-https/verify-sender-to-ingress.mjs
