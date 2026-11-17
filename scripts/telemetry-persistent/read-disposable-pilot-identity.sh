#!/usr/bin/env bash
# D15C-5U-2F2J — read-only disposable PostgreSQL identity evidence.
# DOES NOT START POSTGRESQL. DOES NOT TARGET PROTECTED 55433 OR WRITE.
set -euo pipefail
umask 077

BASE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SQL="$BASE/pilot-identity-evidence.sql"
JS="$BASE/pilot-identity-evidence.mjs"
AUTH="$BASE/pilot-authorization-policy.mjs"
INVENTORY="$BASE/pilot-inventory-policy.mjs"
EXPECTED_SQL='7e4550ea927fc52994b8d9137d3b6f348389a8f3fbb78c055be4aac78151710b'
EXPECTED_JS='e0b18ac52b9e38fee088b6d2eb2bd364d41d2d2dd7fe2254c7dfbee74a7bf390'
EXPECTED_AUTH='8146e464c67b425dff990a1a659d9f7e231b6ffd86e2c4f17bb3fad7bc4d1cd9'
EXPECTED_INVENTORY='332c10803dbf674c2ad31e6fe2c44ac9c143f296228b430853fe416a73ed1a41'

refuse() { echo 'REFUSE_D15C5U2F2J: disposable identity audit denied' >&2; exit 1; }
[[ $# -ge 1 ]] || refuse
if [[ $# -eq 1 && $1 == '--plan' ]]; then
  cat <<'PLAN'
========== D15C-5U-2F2J READ-ONLY IDENTITY AUDIT PLAN ==========
--audit-existing-disposable /tmp/pulse-replay-XXXXXXXXXX/socket
Requires a PRE-EXISTING private PostgreSQL 16 disposable replay on port 55432.
SQL uses REPEATABLE READ, READ ONLY; protects identity of the DB, RLS and
runtime permissions; inspects one owner, tenant, agent and active credential.
No approval, signing key, API, agent, enrollment or persistence is enabled.
The existing 55433 protected cluster and retained backup are never accessed.
NO POSTGRESQL START OR STOP | NO WRITES | PUBLIC LAUNCH: NO_GO
PLAN
  exit 0
fi
[[ $# -eq 2 && $1 == '--audit-existing-disposable' ]] || refuse
SOCKET="$2"
[[ "${NODE_ENV:-development}" == 'development' ]] || refuse
for name in NODE_OPTIONS NODE_EXTRA_CA_CERTS DATABASE_URL MIGRATION_DATABASE_URL \
  PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS \
  PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY; do
  [[ -z "${!name:-}" ]] || refuse
done
[[ $EUID -ne 0 ]] || refuse
[[ $SOCKET =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$ ]] || refuse
[[ -d "$SOCKET" && ! -L "$SOCKET" ]] || refuse
[[ -f "$SQL" && ! -L "$SQL" && -f "$JS" && ! -L "$JS" &&
   -f "$AUTH" && ! -L "$AUTH" &&
   -f "$INVENTORY" && ! -L "$INVENTORY" ]] || refuse
printf '%s\n' "$EXPECTED_JS  $JS" "$EXPECTED_AUTH  $AUTH" \
  "$EXPECTED_INVENTORY  $INVENTORY" | sha256sum -c --status || refuse
for f in "$SQL" "$JS" "$AUTH" "$INVENTORY"; do
  [[ "$(stat -c %h "$f")" == 1 ]] || refuse
done
command -v psql >/dev/null && command -v sudo >/dev/null || refuse

# Open the sha-pinned SQL while still the repository owner. postgres cannot
# necessarily traverse ~/Projects; standard input crosses that boundary safely.
exec 9< "$SQL"
[[ -r /proc/self/fd/9 ]] || refuse
# SHA is checked against the descriptor's inode, not a later path lookup.
[[ "$(sha256sum /proc/self/fd/9 | cut -d ' ' -f1)" == "$EXPECTED_SQL" ]] || refuse
# psql is a client; this script never starts or stops a server. pipefail
# propagates SQL errors, including any target/role/security failure.
sudo -u postgres env -u PGHOST -u PGPORT -u PGOPTIONS \
  psql -X --no-password -A -t -q -v ON_ERROR_STOP=1 \
    -h "$SOCKET" -p 55432 -U postgres -d pulse_metrics -f - <&9 |
  env -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS \
    node "$JS" --verify-disposable-stdin

echo 'PASS: disposable PostgreSQL identity SHAPE reviewed read-only; NO AUTHORIZATION'
