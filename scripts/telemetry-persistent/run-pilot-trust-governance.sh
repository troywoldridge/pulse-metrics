#!/usr/bin/env bash
# Pulse Metrics D15C-5U-2F2M — offline-only trust governance verification.
# No Postgres, sudo, networking, signing key or persistent state operations.
set -euo pipefail
umask 077

BASE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
refuse() { printf 'REFUSE_D15C5U2F2M: offline trust preflight denied\n' >&2; exit 1; }

if [[ $# -eq 1 && $1 == '--plan' ]]; then
  exec node "$BASE/review-pilot-trust-governance.mjs" --plan
fi
[[ $# -eq 1 && $1 == '--verify' ]] || refuse
[[ "$(uname -s)" == 'Linux' ]] || refuse
[[ "${NODE_ENV:-development}" != production ]] || refuse
for variable in NODE_OPTIONS NODE_EXTRA_CA_CERTS DATABASE_URL MIGRATION_DATABASE_URL \
    PGHOST PGPORT PGUSER PGDATABASE PGOPTIONS PGSSLMODE; do
  [[ -z "${!variable:-}" ]] || refuse
done
for bin in node sha256sum stat; do
  command -v "$bin" >/dev/null 2>&1 || refuse
done

for file in pilot-trust-governance.mjs pilot-trust-governance.test.mjs \
    review-pilot-trust-governance.mjs pilot-authorization-policy.mjs \
    pilot-authorization-policy.test.mjs pilot-identity-evidence.mjs \
    pilot-identity-evidence.test.mjs pilot-inventory-policy.mjs; do
  [[ -f "$BASE/$file" && ! -L "$BASE/$file" &&
     "$(stat -c %h "$BASE/$file")" == '1' ]] || refuse
done

printf '%s\n' \
  "7f2c0b9d3de11c92796fe33b5d50bd9b90306e3f19fc9647b3da2e7f41df8d1b  $BASE/pilot-trust-governance.mjs" \
  "016a5b42b96318b97eb5733c8f88658fe630d1f1c5544284b3b84d78ebe41a1a  $BASE/pilot-trust-governance.test.mjs" \
  "74e477a287debdc3b18ce2834a6fd653cf99d1e0946a7f165b39eefbfd18ee2e  $BASE/review-pilot-trust-governance.mjs" \
  "8146e464c67b425dff990a1a659d9f7e231b6ffd86e2c4f17bb3fad7bc4d1cd9  $BASE/pilot-authorization-policy.mjs" \
  "e0b18ac52b9e38fee088b6d2eb2bd364d41d2d2dd7fe2254c7dfbee74a7bf390  $BASE/pilot-identity-evidence.mjs" | sha256sum -c - || refuse

echo '========== 2F2M OFFLINE ROOT / SIGNER / REVIEWER TRUST TESTS =========='
node --test \
  "$BASE/pilot-authorization-policy.test.mjs" \
  "$BASE/pilot-identity-evidence.test.mjs" \
  "$BASE/pilot-trust-governance.test.mjs" || refuse

echo '========== D15C-5U-2F2M OFFLINE TRUST GOVERNANCE: PASS =========='
echo 'EPHEMERAL TEST KEYS ONLY | NO REAL APPROVAL | NO POSTGRESQL | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO'
