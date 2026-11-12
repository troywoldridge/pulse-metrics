#!/usr/bin/env bash
# Pulse Metrics Phase 2E3C5C2B — ISOLATED existing-state adoption rehearsal.
# NEVER installs a ledger/attestation in the existing developer database.
# Uses a newly initialized, Unix-socket-only cluster with its own roles.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset PGHOSTADDR PGHOST PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGCLUSTER PGPASSFILE || true
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -f .env ]] || fail 'Local .env missing; refusing replay'
for exe in node sudo psql pg_config sha256sum mktemp grep cmp; do
  command -v "$exe" >/dev/null || fail "Missing required executable: $exe"
done
node --env-file=.env --input-type=module <<'NODE'
const url = process.env.DATABASE_URL;
if (!url || process.env.NODE_ENV === 'production') throw Error('Refusing production or missing local runtime URL');
const u = new URL(url);
if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(u.hostname.toLowerCase()) ||
    decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(u.username) !== 'pulse_metrics_app') {
  throw Error('Refusing nonlocal or non-runtime database configuration');
}
console.log('PASS: local development configuration guard');
NODE
node scripts/migrations/verify-manifest.mjs
# The existing local database is inspected READ-ONLY by this audit.
bash scripts/migrations/audit-adoption-drift.sh

EXPECTED_CATALOG='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'
MANIFEST_HASH="$(sha256sum scripts/migrations/privileged-manifest.json | cut -d' ' -f1)"
[[ "$MANIFEST_HASH" =~ ^[0-9a-f]{64}$ ]] || fail 'Cannot fingerprint reviewed manifest'
MAIN_VERSION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At -d pulse_metrics -c "SELECT current_setting('server_version_num')")" || fail 'Cannot verify local database version'
[[ "$MAIN_VERSION" =~ ^[0-9]{5,6}$ ]] || fail 'Unexpected PostgreSQL version'
# The real existing ledger must carry the genuine reviewed Drizzle hash.
MAIN_DRIZZLE="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  -c 'SELECT hash FROM public.__drizzle_migrations')" || fail 'Cannot inspect original Drizzle ledger'
[[ "$MAIN_DRIZZLE" == 'd49e23396a343852627ceab778521adaefc6382c2be6111bf83bf3e59ad870e1' ]] ||
  fail 'Existing Drizzle ledger digest differs from reviewed migration'
MAIN_MAJOR="$((MAIN_VERSION / 10000))"
PG_BIN="$(pg_config --bindir)"
if [[ -x "/usr/lib/postgresql/$MAIN_MAJOR/bin/initdb" ]]; then
  PG_BIN="/usr/lib/postgresql/$MAIN_MAJOR/bin"
fi
for exe in initdb pg_ctl postgres createdb; do
  [[ -x "$PG_BIN/$exe" ]] || fail "Missing PostgreSQL binary $PG_BIN/$exe"
done
VERSION_TEXT="$("$PG_BIN/postgres" --version)" || fail 'Cannot inspect PostgreSQL replay binary'
if [[ "$VERSION_TEXT" =~ PostgreSQL\)?[[:space:]]+([0-9]+)([.]|$) ]]; then
  REPLAY_MAJOR="${BASH_REMATCH[1]}"
else
  fail 'Cannot parse PostgreSQL version'
fi
[[ "$REPLAY_MAJOR" == "$MAIN_MAJOR" ]] || fail 'PostgreSQL major versions do not match'
[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Unsupported local username'
[[ "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Unsupported local group'
echo "PASS: isolated PostgreSQL major version $REPLAY_MAJOR"

BASE=''
DATA=''
SOCKET=''
CMP_DIR=''
PORT=55432
STARTED=0
cleanup() {
  local code=$? stopped=1
  trap - EXIT
  set +e
  if [[ -n "$CMP_DIR" && "$CMP_DIR" =~ ^/tmp/pulse-adoption-compare-[A-Za-z0-9]{8}$ ]]; then
    rm -rf -- "$CMP_DIR"
  fi
  if [[ -n "$BASE" && "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
       sudo -u postgres test -f "$BASE/.pulse-adoption-rehearsal-marker"; then
    if [[ "$STARTED" -eq 1 ]]; then
      echo '========== STOP DISPOSABLE POSTGRESQL =========='
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null ||
        sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null || stopped=0
    fi
    if [[ "$stopped" -eq 1 ]] &&
       ! sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres rm -rf -- "$BASE" || stopped=0
    else
      stopped=0
    fi
    if [[ "$stopped" -eq 1 ]]; then
      echo 'PASS: isolated rehearsal cluster and all its roles/data removed'
    else
      echo "CRITICAL: isolated cluster cleanup incomplete; inspect $BASE" >&2
      code=1
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
CMP_DIR="$(mktemp -d /tmp/pulse-adoption-compare-XXXXXXXX)"
chmod 0700 "$CMP_DIR"
BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] || fail 'Unexpected temporary directory'
DATA="$BASE/data"
SOCKET="$BASE/socket"
sudo -u postgres touch "$BASE/.pulse-adoption-rehearsal-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"
sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

printf '%s\n' '========== INITIALIZE DISPOSABLE LEGACY-STYLE CLUSTER =========='
sudo -u postgres "$PG_BIN/initdb" -D "$DATA" --username=postgres \
  --auth-local=peer --auth-host=reject --no-instructions >/dev/null
sudo -u postgres tee "$DATA/pg_ident.conf" >/dev/null <<IDENT
pulse_adoption $(id -un) pulse_metrics_migrator
pulse_adoption $(id -un) pulse_metrics_app
IDENT
sudo -u postgres tee "$DATA/pg_hba.conf" >/dev/null <<'HBA'
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_adoption
local pulse_metrics pulse_metrics_app peer map=pulse_adoption
local all all reject
host all all 0.0.0.0/0 reject
host all all ::/0 reject
HBA
sudo -u postgres tee -a "$DATA/postgresql.conf" >/dev/null <<CONFIG
listen_addresses = ''
port = $PORT
unix_socket_directories = '$SOCKET'
unix_socket_permissions = 0777
logging_collector = off
CONFIG
STARTED=1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/start.log" -w start >/dev/null
REPLAY_INFO="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -At \
  -h "$SOCKET" -p "$PORT" -U postgres -d postgres \
  -c "SELECT current_setting('data_directory') || '|' || current_database() || '|' || current_user || '|' || (inet_server_addr() IS NULL)::text || '|' || (current_setting('listen_addresses')='')::text")"
[[ "$REPLAY_INFO" == "$DATA|postgres|postgres|true|true" ]] || fail 'Cannot prove isolated Unix-socket target'
echo 'PASS: socket, data directory and TCP-disabled isolation verified'

psql_admin() {
  local db="$1"; shift
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$db" "$@"
}
psql_admin postgres < scripts/replay/bootstrap-roles.sql
sudo -u postgres "$PG_BIN/createdb" -h "$SOCKET" -p "$PORT" -U postgres -O postgres pulse_metrics
psql_admin pulse_metrics < scripts/replay/bootstrap-database.sql
PULSE_REPLAY_SOCKET="$SOCKET" PULSE_REPLAY_DATA="$DATA" PULSE_REPLAY_PORT="$PORT" \
  node scripts/replay/migrate-isolated.mjs
psql_admin pulse_metrics < scripts/replay/runtime-grants.sql
REPLAY_DRIZZLE="$(psql_admin pulse_metrics -Atq -c 'SELECT hash FROM public.__drizzle_migrations')" ||
  fail 'Cannot inspect replay Drizzle ledger'
[[ "$REPLAY_DRIZZLE" == "$MAIN_DRIZZLE" ]] || fail 'Replay Drizzle ledger differs from reviewed baseline'

printf '%s\n' '========== CONSTRUCT LEGACY STATE WITHOUT PRIVILEGED RECEIPTS =========='
while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ && "$source" == scripts/admin/${version}_* &&
     "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ &&
     "$digest" =~ ^[0-9a-f]{64}$ ]] || fail 'Unreviewed SQL manifest output'
  [[ "$(sha256sum "$source" | cut -d' ' -f1)" == "$digest" ]] || fail 'Privileged source checksum changed'
  echo "Legacy bootstrap $version (isolated only, no receipt)"
  psql_admin pulse_metrics -q < "$source"
done < <(node scripts/migrations/verify-manifest.mjs --tsv)
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/current.txt"
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/legacy.txt"
[[ "$(sha256sum "$CMP_DIR/current.txt" | cut -d' ' -f1)" == "$EXPECTED_CATALOG" ]] ||
  fail 'Existing database no longer matches independently pinned catalog'
cmp -s "$CMP_DIR/current.txt" "$CMP_DIR/legacy.txt" || fail 'Legacy-style isolated catalog mismatch'
echo 'PASS: simulated pre-ledger installation matches existing baseline'

printf '%s\n' '========== ADD PRIVATE LEDGER WITHOUT FRESH-EXECUTION RECEIPTS =========='
psql_admin pulse_metrics -q < scripts/migrations/ledger-bootstrap.sql
psql_admin pulse_metrics -q < scripts/migrations/adoption-attestation-bootstrap.sql

# Detect and refuse retry of legacy SQL with an absent fresh-replay receipt.
if {
  printf 'BEGIN READ ONLY;\n'
  printf "SELECT set_config('pulse.replay_step_version','001',true);\n"
  cat scripts/migrations/step-preflight-assert.sql
  printf 'COMMIT;\n'
} | psql_admin pulse_metrics -q > "$CMP_DIR/replay-refusal.log" 2>&1; then
  fail 'Unrecorded existing privileged function was incorrectly accepted for replay'
fi
grep -Fq 'UNRECORDED_EXISTING_OBJECT' "$CMP_DIR/replay-refusal.log" ||
  fail 'Unsafe replay refused for unexpected reason'
echo 'PASS: legacy objects without execution receipts cannot be replayed'

printf '%s\n' '========== INJECT TEMPORARY DRIFT BEFORE ADOPTION =========='
psql_admin pulse_metrics -q <<'SQL'
BEGIN;
GRANT SELECT ON public.invitation_rate_limits TO pulse_metrics_app;
COMMIT;
SQL
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/drifted.txt"
if cmp -s "$CMP_DIR/current.txt" "$CMP_DIR/drifted.txt"; then
  fail 'Expected test-only grant drift was not detected'
fi
grep -Fq 'grant|invitation_rate_limits|SELECT|true' "$CMP_DIR/drifted.txt" ||
  fail 'Observed drift did not match injected grant'
[[ "$(psql_admin pulse_metrics -Atq -c 'SELECT count(*) FROM pulse_security_migrations.verified_existing_baselines')" == 0 ]] ||
  fail 'Attestation was unexpectedly recorded during drift'
echo 'PASS: catalog drift blocks adoption BEFORE any attestation write'
psql_admin pulse_metrics -q <<'SQL'
BEGIN;
REVOKE SELECT ON public.invitation_rate_limits FROM pulse_metrics_app;
COMMIT;
SQL
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/restored.txt"
cmp -s "$CMP_DIR/current.txt" "$CMP_DIR/restored.txt" || fail 'Could not restore catalog after drift drill'
echo 'PASS: isolated catalog restored exactly'

printf '%s\n' '========== RECORD OBSERVED STATE, NOT INVENTED EXECUTION HISTORY =========='
# Recheck the source database catalog before recording isolated attestation.
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/main-before-adoption.txt"
cmp -s "$CMP_DIR/current.txt" "$CMP_DIR/main-before-adoption.txt" ||
  fail 'Existing database changed during the adoption rehearsal'
# Re-verify reviewed sources and exact catalog immediately before write.
node scripts/migrations/verify-manifest.mjs
[[ "$(sha256sum scripts/migrations/privileged-manifest.json | cut -d' ' -f1)" == "$MANIFEST_HASH" ]] ||
  fail 'Manifest changed during rehearsal'
psql_admin pulse_metrics -q -v "manifest_sha256=$MANIFEST_HASH" \
  -v "catalog_sha256=$EXPECTED_CATALOG" \
  < scripts/migrations/adoption-attestation-record.sql
psql_admin pulse_metrics -q < scripts/migrations/adoption-attestation-audit.sql

printf '%s\n' '========== DENY REPEATED ATTESTATION =========='
if psql_admin pulse_metrics -q -v "manifest_sha256=$MANIFEST_HASH" \
  -v "catalog_sha256=$EXPECTED_CATALOG" \
  < scripts/migrations/adoption-attestation-record.sql \
  > "$CMP_DIR/duplicate.log" 2>&1; then
  fail 'Duplicate attestation was unexpectedly allowed'
fi
grep -Fq 'REFUSE_ADOPTION_WRITE' "$CMP_DIR/duplicate.log" ||
  fail 'Duplicate write refused for unexpected reason'
psql_admin pulse_metrics -q < scripts/migrations/adoption-attestation-audit.sql
STORED_ATTESTATION="$(psql_admin pulse_metrics -Atq -c \
  "SELECT source_manifest_sha256 || '|' || catalog_sha256 FROM pulse_security_migrations.verified_existing_baselines")" ||
  fail 'Cannot inspect attestation contents'
[[ "$STORED_ATTESTATION" == "$MANIFEST_HASH|$EXPECTED_CATALOG" ]] ||
  fail 'Isolated attestation stored unexpected digests'
echo 'PASS: duplicate attestation rejected and original attestation preserved'

printf '%s\n' '========== VERIFY RUNTIME ROLE CANNOT READ ADOPTION RECORD =========='
RUNTIME_INFO="$(psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_app -d pulse_metrics \
  -c "SELECT current_user || '|' || current_database() || '|' || (inet_server_addr() IS NULL)::text")" ||
  fail 'Cannot authenticate as the restricted runtime in isolated cluster'
[[ "$RUNTIME_INFO" == 'pulse_metrics_app|pulse_metrics|true' ]] ||
  fail 'Runtime probe did not reach the intended isolated cluster'
if psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_app -d pulse_metrics \
  -c 'SELECT * FROM pulse_security_migrations.verified_existing_baselines' >/dev/null 2>&1; then
  fail 'Ordinary app role can read private adoption attestation'
fi
if psql -X -v ON_ERROR_STOP=1 -At -h "$SOCKET" -p "$PORT" \
  -U pulse_metrics_app -d pulse_metrics \
  -c 'SELECT * FROM pulse_security_migrations.applied_privileged_steps' >/dev/null 2>&1; then
  fail 'Ordinary app role can read private privileged receipts'
fi
echo 'PASS: verified restricted app connection; both private ledgers deny access'

sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -h "$SOCKET" -p "$PORT" -U postgres -d pulse_metrics \
  < scripts/replay/catalog-manifest.sql > "$CMP_DIR/attested.txt"
cmp -s "$CMP_DIR/current.txt" "$CMP_DIR/attested.txt" ||
  fail 'Attestation changed application-security catalog'
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
psql_admin pulse_metrics -q < scripts/migrations/adoption-attestation-audit.sql
printf '%s\n' 'PASS: verified_existing attestation, zero fresh-replay receipts, original Drizzle history, and exact public catalog parity'
printf '%s\n' 'NOTE: isolated rehearsal only; existing developer database was READ ONLY and is NOT adopted.'
