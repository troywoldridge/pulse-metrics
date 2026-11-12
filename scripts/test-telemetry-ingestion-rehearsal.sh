#!/usr/bin/env bash
# Pulse Metrics D15B: disposable PostgreSQL migration rehearsal.
# No production deployment, no public endpoints, no real credentials.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE \
  PGSERVICEFILE PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER \
  PGSSLMODE PGSSLROOTCERT PGSSLKEY PGSSLCERT || true

fail() {
  printf 'REFUSE_D15B_REHEARSAL: %s\n' "$*" >&2
  exit 1
}

[[ -f .env ]] || fail 'Local development .env missing'

for tool in node sudo psql pg_config sha256sum mktemp git timeout; do
  command -v "$tool" >/dev/null ||
    fail "Missing prerequisite: $tool"
done

# Refuse production and unexpected developer database configuration.
node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;

if (!raw || process.env.NODE_ENV === 'production') {
  throw new Error('Production or missing database configuration refused');
}

const u = new URL(raw);

if (
  !['postgres:', 'postgresql:'].includes(u.protocol) ||
  !['localhost', '127.0.0.1', '::1'].includes(
    u.hostname.toLowerCase()
  ) ||
  decodeURIComponent(u.pathname.slice(1)) !== 'pulse_metrics' ||
  decodeURIComponent(u.username) !== 'pulse_metrics_app'
) {
  throw new Error('Only reviewed local development configuration allowed');
}

console.log('PASS: development-only configuration verified');
NODE

echo '========== VERIFY HISTORICAL SOURCES =========='

node scripts/migrations/verify-manifest.mjs
node scripts/agent-enrollment/verify-candidate.mjs

CANDIDATE='scripts/telemetry-ingestion/migrations/0001_telemetry_ingestion.sql'

[[ -s "$CANDIDATE" ]] ||
  fail 'D15B candidate is missing or empty'

# This is the exact currently reviewed candidate, not an approval pin.
EXPECTED='5aaf960e061adf5c6883041fc81535dc2160091cedb29d599c11d374bfc0cd41'

ACTUAL="$(sha256sum "$CANDIDATE" | cut -d' ' -f1)"

[[ "$ACTUAL" == "$EXPECTED" ]] ||
  fail 'D15B SQL changed since the last source review'

echo 'PASS: D15B candidate matches reviewed input'

BASELINE='6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977'

# Read-only verification of existing developer database.
BEFORE="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -d pulse_metrics < scripts/replay/catalog-manifest.sql |
  sha256sum | cut -d' ' -f1)"

[[ "$BEFORE" == "$BASELINE" ]] ||
  fail 'Existing development database differs from protected baseline'

echo 'PASS: existing development catalog matches baseline'

MAIN_VERSION="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 \
  -At -d pulse_metrics \
  -c "SELECT current_setting('server_version_num')")"

[[ "$MAIN_VERSION" =~ ^[0-9]{5,6}$ ]] ||
  fail 'Unexpected PostgreSQL version'

MAJOR="$((MAIN_VERSION / 10000))"
PG_BIN="$(pg_config --bindir)"

if [[ -x "/usr/lib/postgresql/$MAJOR/bin/initdb" ]]; then
  PG_BIN="/usr/lib/postgresql/$MAJOR/bin"
fi

for tool in initdb pg_ctl postgres psql createdb; do
  [[ -x "$PG_BIN/$tool" ]] ||
    fail "Missing PostgreSQL binary: $tool"
done

[[ "$("$PG_BIN/postgres" --version)" =~ PostgreSQL[^0-9]*${MAJOR}[.] ]] ||
  fail 'PostgreSQL binary version mismatch'

[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
  fail 'Unexpected operating system user'

[[ "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
  fail 'Unexpected operating system group'

BASE=''
DATA=''
SOCKET=''
PORT=55432

cleanup() {
  local code=$?
  local stopped=1
  trap - EXIT
  set +e

  if [[ -n "$BASE" &&
        "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
     sudo -u postgres test -f "$BASE/.pulse-telemetry-marker"; then

    echo '========== STOP DISPOSABLE D15B CLUSTER =========='

    if sudo -u postgres "$PG_BIN/pg_ctl" \
      -D "$DATA" status >/dev/null 2>&1; then

      sudo -u postgres "$PG_BIN/pg_ctl" \
        -D "$DATA" -m fast -w stop >/dev/null 2>&1 ||
      sudo -u postgres "$PG_BIN/pg_ctl" \
        -D "$DATA" -m immediate -w stop >/dev/null 2>&1 ||
      stopped=0
    fi

    if [[ "$stopped" -eq 1 ]] &&
       ! sudo -u postgres "$PG_BIN/pg_ctl" \
         -D "$DATA" status >/dev/null 2>&1; then

      sudo -u postgres rm -rf -- "$BASE" || stopped=0
    else
      stopped=0
    fi

    if [[ "$stopped" -eq 0 ]]; then
      echo "CRITICAL: isolated cluster retained at $BASE" >&2
      code=1
    else
      echo 'PASS: disposable D15B cluster removed'
    fi
  fi

  exit "$code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"

[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] ||
  fail 'Unexpected disposable directory'

DATA="$BASE/data"
SOCKET="$BASE/socket"

sudo -u postgres touch "$BASE/.pulse-telemetry-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"

sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

echo '========== CREATE DISPOSABLE POSTGRESQL CLUSTER =========='

sudo -u postgres "$PG_BIN/initdb" \
  -D "$DATA" --username=postgres \
  --auth-local=peer --auth-host=reject \
  --no-instructions >/dev/null

sudo -u postgres tee "$DATA/pg_ident.conf" >/dev/null <<IDENT
pulse_release $(id -un) pulse_metrics_migrator
pulse_release $(id -un) pulse_metrics_app
IDENT

sudo -u postgres tee "$DATA/pg_hba.conf" >/dev/null <<'HBA'
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_release
local pulse_metrics pulse_metrics_app peer map=pulse_release
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

sudo -u postgres "$PG_BIN/pg_ctl" \
  -D "$DATA" -l "$BASE/start.log" -w start >/dev/null

# Verify actual PostgreSQL data directory and socket identity.
IDENTITY="$(sudo -u postgres "$PG_BIN/psql" \
  -X -v ON_ERROR_STOP=1 -At \
  -h "$SOCKET" -p "$PORT" -U postgres -d postgres \
  -c "SELECT current_setting('data_directory') || '|' ||
      current_user || '|' ||
      (inet_server_addr() IS NULL)::text || '|' ||
      (current_setting('listen_addresses') = '')::text")"

[[ "$IDENTITY" == "$DATA|postgres|true|true" ]] ||
  fail 'Disposable cluster identity verification failed'

echo 'PASS: isolated Unix socket, TCP disabled, correct data directory'

psql_admin() {
  local db="$1"
  shift
  sudo -u postgres "$PG_BIN/psql" \
    -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$db" "$@"
}

echo '========== INSTALL ORIGINAL DATABASE FOUNDATION =========='

psql_admin postgres -q < scripts/replay/bootstrap-roles.sql

sudo -u postgres "$PG_BIN/createdb" \
  -h "$SOCKET" -p "$PORT" \
  -U postgres -O postgres pulse_metrics

psql_admin pulse_metrics -q < scripts/replay/bootstrap-database.sql

PULSE_REPLAY_SOCKET="$SOCKET" \
PULSE_REPLAY_DATA="$DATA" \
PULSE_REPLAY_PORT="$PORT" \
  node scripts/replay/migrate-isolated.mjs

psql_admin pulse_metrics -q < scripts/replay/runtime-grants.sql
psql_admin pulse_metrics -q < scripts/migrations/ledger-bootstrap.sql

STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)"

[[ "$(printf '%s\n' "$STEPS" | wc -l)" -eq 6 ]] ||
  fail 'Expected six historical privileged migration steps'

while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ ]] ||
    fail 'Unexpected historical migration version'

  [[ "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ ]] ||
    fail 'Unexpected historical migration path'

  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'Invalid historical migration digest'

  {
    printf 'BEGIN READ ONLY;\n'
    printf "SELECT set_config('pulse.replay_step_version','%s',true);\n" "$version"
    cat scripts/migrations/step-preflight-assert.sql
    printf 'COMMIT;\n'
  } | psql_admin pulse_metrics -q >/dev/null

  psql_admin pulse_metrics -q < "$source"

  psql_admin pulse_metrics -q \
    -v "version=$version" \
    -v "source_path=$source" \
    -v "digest=$digest" \
    < scripts/migrations/ledger-record.sql

  echo "PASS: historical privileged migration $version"
done <<< "$STEPS"

psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql

psql_admin pulse_metrics -q \
  < scripts/agent-enrollment/migrations/0001_agent_enrollment.sql

echo 'PASS: protected agent-enrollment migration installed'

echo '========== ATTEMPT D15B CANDIDATE INSTALLATION =========='

psql_admin pulse_metrics -q < "$CANDIDATE"

echo 'PASS: D15B migration installed in disposable PostgreSQL'

echo '========== CHECK D15B DATABASE PERMISSIONS =========='

psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;

DO $check$
DECLARE
  v_role record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls,
         rolcreatedb, rolcreaterole, rolinherit
    INTO v_role
  FROM pg_roles
  WHERE rolname = 'pulse_metrics_telemetry_executor';

  IF NOT FOUND
     OR v_role.rolcanlogin
     OR v_role.rolsuper
     OR NOT v_role.rolbypassrls
     OR v_role.rolcreatedb
     OR v_role.rolcreaterole
     OR v_role.rolinherit
  THEN
    RAISE EXCEPTION 'Unexpected telemetry executor role privileges';
  END IF;

  IF has_table_privilege(
       'pulse_metrics_app',
       'public.agent_credentials', 'SELECT'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'public.agent_credentials', 'UPDATE'
     )
     OR has_table_privilege(
       'pulse_metrics_app',
       'pulse_telemetry_ingestion.submissions', 'SELECT'
     )
  THEN
    RAISE EXCEPTION 'Ordinary app can access protected telemetry identity data';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid = 'pulse_telemetry_ingestion.submissions'::regclass
      AND relrowsecurity
      AND relforcerowsecurity
      AND relowner = 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'Submission ledger security mismatch';
  END IF;

  RAISE NOTICE 'PASS: role and protected ledger security checks';
END;
$check$;

COMMIT;
SQL

echo '========== CHECK ROW-LOCK PRIVILEGES =========='

# Row-lock operations cannot execute inside READ ONLY transactions.
# This is a disposable isolated database with synthetic data only.
# LIMIT 0 returns no rows; no persistent table changes are made.
psql_admin pulse_metrics -q <<'SQL'
BEGIN;

SET LOCAL ROLE pulse_metrics_telemetry_executor;

SELECT status
FROM public.monitored_agents
LIMIT 0
FOR SHARE;

SELECT id, organization_id, agent_id
FROM public.agent_credentials
LIMIT 0
FOR SHARE;

COMMIT;
SQL

echo 'PASS: dedicated executor row-lock privileges verified'

echo '========== CREATE SYNTHETIC D15B CUSTOMERS =========='

psql_admin pulse_metrics -q <<'SQL'
BEGIN;

SELECT public.resolve_workos_user('user_agent_owner_a');
SELECT public.resolve_workos_user('user_agent_owner_b');

SELECT * FROM public.create_workos_organization(
  'user_agent_owner_a',
  'D15B Synthetic Customer A',
  'pulse-agent-a'
);

SELECT * FROM public.create_workos_organization(
  'user_agent_owner_b',
  'D15B Synthetic Customer B',
  'pulse-agent-b'
);

COMMIT;
SQL

ORG_A="$(psql_admin pulse_metrics -Atq -c \
  "SELECT id FROM public.organizations WHERE slug='pulse-agent-a'")"

ORG_B="$(psql_admin pulse_metrics -Atq -c \
  "SELECT id FROM public.organizations WHERE slug='pulse-agent-b'")"

[[ "$ORG_A" =~ ^[0-9a-f-]{36}$ &&
   "$ORG_B" =~ ^[0-9a-f-]{36}$ &&
   "$ORG_A" != "$ORG_B" ]] ||
  fail 'Synthetic customer identity fixture failed'

echo '========== TEST D15B AUTHORIZATION AND PERSISTENCE =========='

timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES \
  PULSE_AGENT_SOCKET="$SOCKET" \
  PULSE_AGENT_DATA="$DATA" \
  PULSE_AGENT_ORG_A="$ORG_A" \
  PULSE_AGENT_ORG_B="$ORG_B" \
  node scripts/telemetry-ingestion/functional-integration.mjs

echo '========== VERIFY STORED TELEMETRY OWNERSHIP =========='

psql_admin pulse_metrics -q <<'SQL'
BEGIN READ ONLY;

DO $verify$
DECLARE
  v_total integer;
  v_a integer;
  v_b integer;
BEGIN
  SELECT count(*) INTO v_total
  FROM public.telemetry_samples;

  SELECT count(*) INTO v_a
  FROM public.telemetry_samples t
  JOIN public.organizations o
    ON o.id = t.organization_id
  WHERE o.slug = 'pulse-agent-a';

  SELECT count(*) INTO v_b
  FROM public.telemetry_samples t
  JOIN public.organizations o
    ON o.id = t.organization_id
  WHERE o.slug = 'pulse-agent-b';

  IF v_total <> 2 OR v_a <> 1 OR v_b <> 1 THEN
    RAISE EXCEPTION
      'Telemetry ownership or duplicate count mismatch';
  END IF;

  IF (
    SELECT count(*)
    FROM pulse_telemetry_ingestion.submissions
  ) <> 2 THEN
    RAISE EXCEPTION
      'Submission ledger count mismatch';
  END IF;

  RAISE NOTICE
    'PASS: exactly two telemetry rows, one per customer';
END;
$verify$;

COMMIT;
SQL

echo '========== TEST D15B REAL CONCURRENCY =========='

timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES \
  PULSE_AGENT_SOCKET="$SOCKET" \
  PULSE_AGENT_DATA="$DATA" \
  PULSE_AGENT_ORG_A="$ORG_A" \
  PULSE_AGENT_ORG_B="$ORG_B" \
  node scripts/telemetry-ingestion/concurrency-integration.mjs

echo 'PASS: concurrent retries, conflicts and revocation tested'

echo '========== CHECK DEVELOPMENT DATABASE UNCHANGED =========='

AFTER="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -d pulse_metrics < scripts/replay/catalog-manifest.sql |
  sha256sum | cut -d' ' -f1)"

[[ "$AFTER" == "$BEFORE" ]] ||
  fail 'Development database catalog changed during rehearsal'

echo 'PASS: development database catalog unchanged'
echo 'D15B MIGRATION REHEARSAL: INSTALLATION AND ACL CHECKS PASSED'
echo 'NOTE: functional and concurrency smoke tests passed; expiry, scope, forced lock-order races and security approval remain pending'
echo 'PUBLIC LAUNCH: NO_GO'
