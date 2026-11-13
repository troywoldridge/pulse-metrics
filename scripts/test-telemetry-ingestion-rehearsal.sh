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

# Verify the manifest and source against the independent D15B lock.
# This does not approve or install the candidate.
node scripts/telemetry-ingestion/verify-candidate.mjs

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

echo '========== D15B FAILED INSTALLATION ATOMICITY TEST =========='

# The disposable PostgreSQL cluster must already be initialized.
# Use a temporary copy; never change the reviewed migration.
# Create the SQL probe outside the restricted PostgreSQL directory.
# Only the disposable PostgreSQL cluster will execute this test copy.
ROLLBACK_PROBE="$(mktemp /tmp/pulse-d15b-rollback-XXXXXXXX.sql)"
chmod 600 "$ROLLBACK_PROBE"

python3 - "$CANDIDATE" "$ROLLBACK_PROBE" <<'PYROLLBACK'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8")
destination = Path(sys.argv[2])

ending = "\nCOMMIT;\n"

if not source.endswith(ending):
    raise SystemExit("REFUSE: unexpected migration ending")

if source.count("\nCOMMIT;") != 1:
    raise SystemExit("REFUSE: ambiguous migration COMMIT")

failure = (
    "\nDO $d15b_forced_failure$\n"
    "BEGIN\n"
    "  RAISE EXCEPTION 'D15B_EXPECTED_ATOMIC_ROLLBACK'\n"
    "    USING ERRCODE = 'P0001';\n"
    "END;\n"
    "$d15b_forced_failure$;\n"
)

destination.write_text(
    source[:-len(ending)] + failure + ending,
    encoding="utf-8",
)
PYROLLBACK

if ROLLBACK_OUTPUT="$(psql_admin pulse_metrics -q \
  < "$ROLLBACK_PROBE" 2>&1)"; then
  fail 'D15B deliberately broken migration unexpectedly succeeded'
fi

if [[ "$ROLLBACK_OUTPUT" != *"D15B_EXPECTED_ATOMIC_ROLLBACK"* ]]; then
  printf '%s\n' "$ROLLBACK_OUTPUT"
  fail 'D15B rollback failed for an unexpected reason'
fi

echo 'PASS: forced installation failure detected'

# Verify rollback using a fresh PostgreSQL session.
psql_admin pulse_metrics -q <<'SQLROLLBACK'
BEGIN READ ONLY;

DO $verify$
BEGIN
  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL
  THEN
    RAISE EXCEPTION 'Unsafe rollback verification environment';
  END IF;

  IF to_regnamespace('pulse_telemetry_ingestion') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname = 'pulse_metrics_telemetry_executor'
     )
  THEN
    RAISE EXCEPTION
      'D15B_ROLLBACK_FAILURE: security objects survived';
  END IF;

  IF NOT has_any_column_privilege(
    'pulse_metrics_app',
    'public.telemetry_samples',
    'INSERT'
  ) THEN
    RAISE EXCEPTION
      'D15B_ROLLBACK_FAILURE: original grants were altered';
  END IF;

  RAISE NOTICE
    'PASS: failed migration left no D15B schema, receipt, or executor role';
END;
$verify$;

COMMIT;
SQLROLLBACK

rm -f -- "$ROLLBACK_PROBE"

echo 'PASS: D15B failed installation rolled back atomically'

echo '========== INSTALL ORIGINAL D15B CANDIDATE =========='

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

echo '========== D15B PRIVILEGE ESCALATION TEST =========='

timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES \
  PULSE_AGENT_SOCKET="$SOCKET" \
  PULSE_AGENT_DATA="$DATA" \
  node scripts/telemetry-ingestion/privilege-integration.mjs

echo '========== D15B ADMINISTRATOR PRIVILEGE AUDIT =========='

psql_admin pulse_metrics -q \
  < scripts/telemetry-ingestion/privilege-audit.sql

echo 'PASS: D15B privilege abuse and grant audits passed'

echo '========== D15B EXPIRED CREDENTIAL FIXTURE =========='

psql_admin pulse_metrics -q <<'SQL'
BEGIN;

DO $fixture$
DECLARE
  v_agent uuid;
  v_org uuid;
  v_rotated boolean;
BEGIN
  SELECT a.id, a.organization_id
  INTO STRICT v_agent, v_org
  FROM public.monitored_agents a
  JOIN public.organizations o
    ON o.id = a.organization_id
  WHERE o.slug = 'pulse-agent-b'
    AND a.status = 'active';

  SELECT pulse_agent_enrollment.rotate_credential(
    'user_agent_owner_b',
    v_org,
    v_agent,
    repeat('1',64),
    repeat('1',12)
  ) INTO v_rotated;

  IF v_rotated IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Synthetic expiry rotation failed';
  END IF;

  UPDATE public.agent_credentials
  SET expires_at = clock_timestamp() - interval '1 minute'
  WHERE token_hash = repeat('1',64)
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Synthetic expiry fixture missing';
  END IF;
END;
$fixture$;

COMMIT;
SQL

timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES \
  PULSE_AGENT_SOCKET="$SOCKET" \
  PULSE_AGENT_DATA="$DATA" \
  node scripts/telemetry-ingestion/credential-negative-integration.mjs expired

echo '========== D15B MISSING SCOPE FIXTURE =========='

psql_admin pulse_metrics -q <<'SQL'
BEGIN;

DO $fixture$
DECLARE
  v_agent uuid;
  v_org uuid;
  v_rotated boolean;
BEGIN
  SELECT a.id, a.organization_id
  INTO STRICT v_agent, v_org
  FROM public.monitored_agents a
  JOIN public.organizations o
    ON o.id = a.organization_id
  WHERE o.slug = 'pulse-agent-b'
    AND a.status = 'active';

  SELECT pulse_agent_enrollment.rotate_credential(
    'user_agent_owner_b',
    v_org,
    v_agent,
    repeat('2',64),
    repeat('2',12)
  ) INTO v_rotated;

  IF v_rotated IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Synthetic scope rotation failed';
  END IF;

  UPDATE public.agent_credentials
  SET scopes = '[]'::jsonb
  WHERE token_hash = repeat('2',64)
    AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Synthetic scope fixture missing';
  END IF;
END;
$fixture$;

COMMIT;
SQL

timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES \
  PULSE_AGENT_SOCKET="$SOCKET" \
  PULSE_AGENT_DATA="$DATA" \
  node scripts/telemetry-ingestion/credential-negative-integration.mjs missing-scope

echo 'PASS: credential expiry and scope enforcement verified'

echo '========== D15B CONTROLLED ADMINISTRATIVE LOCK TEST =========='

timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES \
  PULSE_AGENT_SOCKET="$SOCKET" \
  PULSE_AGENT_DATA="$DATA" \
  PULSE_AGENT_ORG_A="$ORG_A" \
  PULSE_AGENT_ORG_B="$ORG_B" \
  node scripts/telemetry-ingestion/lock-order-integration.mjs

echo 'PASS: controlled revocation and rotation lock-ordering verified'

echo '========== D15B DIRECT TELEMETRY INSERT BYPASS TEST =========='

timeout --signal=TERM --kill-after=10s 120s env \
  PULSE_AGENT_DISPOSABLE_ONLY=YES \
  PULSE_AGENT_SOCKET="$SOCKET" \
  PULSE_AGENT_DATA="$DATA" \
  PULSE_AGENT_ORG_A="$ORG_A" \
  node scripts/telemetry-ingestion/direct-insert-integration.mjs

echo 'PASS: direct application telemetry INSERT bypass denied'

echo '========== D15B LEGACY GRANT REGRESSION TEST =========='

psql_admin pulse_metrics -q \
  < scripts/telemetry-ingestion/grant-regression.sql

echo 'PASS: legacy grant regression reproduced and rolled back'

echo '========== D15B POST-MIGRATION RELEASE PERMISSION GATE =========='

psql_admin pulse_metrics -q \
  < scripts/telemetry-ingestion/release-permission-gate.sql

echo 'PASS: D15B release permission gate accepted secure grants'

echo '========== D15B RELEASE GATE NEGATIVE TEST =========='

# This administrator wrapper is already restricted to the
# verified disposable Unix-socket PostgreSQL cluster.
# Deliberately reintroduce the old, unsafe permission.
psql_admin pulse_metrics -q -c '
  GRANT INSERT ON public.telemetry_samples
  TO pulse_metrics_app;
'

# A secure release gate MUST refuse this database.
if GATE_OUTPUT="$(psql_admin pulse_metrics -q \
  < scripts/telemetry-ingestion/release-permission-gate.sql 2>&1)"; then
  fail 'D15B release gate accepted unsafe telemetry INSERT grants'
fi

# The failure must be for the intended reason, rather
# than an unrelated SQL syntax or connection error.
if [[ "$GATE_OUTPUT" != *"D15B_RELEASE_NO_GO: unsafe telemetry application grants"* ]]; then
  fail 'D15B release gate failed for an unexpected reason'
fi

echo 'PASS: release gate rejected restored legacy INSERT privilege'

# Undo the simulated privileged regression.
psql_admin pulse_metrics -q -c '
  REVOKE INSERT ON public.telemetry_samples
  FROM pulse_metrics_app;
'

# After remediation, the release gate must pass again.
psql_admin pulse_metrics -q \
  < scripts/telemetry-ingestion/release-permission-gate.sql

echo 'PASS: release gate accepted restored secure permissions'


echo '========== D15B ALTERED RECEIPT REJECTION TEST =========='

psql_admin pulse_metrics -q -c "
  UPDATE pulse_telemetry_ingestion.schema_migrations
  SET description = 'INTENTIONALLY ALTERED TEST RECEIPT'
  WHERE version = '0001';
"

if RECEIPT_OUTPUT="$(psql_admin pulse_metrics -q \
  < scripts/telemetry-ingestion/release-permission-gate.sql 2>&1)"; then
  fail 'Release gate accepted an altered installation receipt'
fi

if [[ "$RECEIPT_OUTPUT" != *"D15B_RELEASE_NO_GO: installation receipt mismatch"* ]]; then
  printf '%s\n' "$RECEIPT_OUTPUT"
  fail 'Altered receipt was rejected for an unexpected reason'
fi

echo 'PASS: altered installation receipt rejected'

psql_admin pulse_metrics -q -c "
  UPDATE pulse_telemetry_ingestion.schema_migrations
  SET description =
    'Credential-authenticated telemetry ingestion, revision 1'
  WHERE version = '0001';
"

echo '========== D15B MISSING RECEIPT REJECTION TEST =========='

psql_admin pulse_metrics -q -c "
  DELETE FROM pulse_telemetry_ingestion.schema_migrations
  WHERE version = '0001';
"

if RECEIPT_OUTPUT="$(psql_admin pulse_metrics -q \
  < scripts/telemetry-ingestion/release-permission-gate.sql 2>&1)"; then
  fail 'Release gate accepted a missing installation receipt'
fi

if [[ "$RECEIPT_OUTPUT" != *"D15B_RELEASE_NO_GO: installation receipt mismatch"* ]]; then
  printf '%s\n' "$RECEIPT_OUTPUT"
  fail 'Missing receipt was rejected for an unexpected reason'
fi

echo 'PASS: missing installation receipt rejected'

psql_admin pulse_metrics -q -c "
  INSERT INTO pulse_telemetry_ingestion.schema_migrations
    (version, description)
  VALUES (
    '0001',
    'Credential-authenticated telemetry ingestion, revision 1'
  );
"

echo '========== D15B RECEIPT RESTORATION TEST =========='

psql_admin pulse_metrics -q \
  < scripts/telemetry-ingestion/release-permission-gate.sql

echo 'PASS: restored installation receipt accepted'




echo '========== CHECK DEVELOPMENT DATABASE UNCHANGED =========='

AFTER="$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq \
  -d pulse_metrics < scripts/replay/catalog-manifest.sql |
  sha256sum | cut -d' ' -f1)"

[[ "$AFTER" == "$BEFORE" ]] ||
  fail 'Development database catalog changed during rehearsal'

echo 'PASS: development database catalog unchanged'
echo 'D15B MIGRATION REHEARSAL: INSTALLATION AND ACL CHECKS PASSED'
echo 'NOTE: functional, credential, concurrency, direct-write and privilege tests passed; final deployment lifecycle review and security approval remain pending'
echo 'PUBLIC LAUNCH: NO_GO'
