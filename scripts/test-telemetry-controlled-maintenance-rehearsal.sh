#!/usr/bin/env bash
# Pulse Metrics D15C-5C: FULLY DISPOSABLE maintenance operations rehearsal.
# Fresh PostgreSQL cluster on its own Unix socket. TCP disabled.
# This file does not use DATABASE_URL for database connections.
# No working development/customer database writes are permitted.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Never allow libpq connection environment to redirect test commands.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGPASSWORD PGPASSFILE PGCLUSTER PGSSLMODE PGSSLROOTCERT \
  PGSSLKEY PGSSLCERT || true

refuse() { printf 'REFUSE_D15C4_REHEARSAL: %s\n' "$*" >&2; exit 1; }

for bin in node sudo psql pg_config sha256sum mktemp git timeout python3; do
  command -v "$bin" >/dev/null 2>&1 || refuse "Missing prerequisite: $bin"
done

[[ -f .env ]] || refuse 'Expected local development .env'

node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw || process.env.NODE_ENV === 'production') {
  throw new Error('Refusing missing or production development configuration');
}
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase()) ||
    decodeURIComponent(url.pathname.slice(1)) !== 'pulse_metrics' ||
    decodeURIComponent(url.username) !== 'pulse_metrics_app') {
  throw new Error('Only reviewed local development configuration allowed');
}
console.log('PASS: local-only development configuration checked (not connected)');
NODE

echo '========== VERIFY LOCKED MIGRATION SOURCES =========='
node scripts/migrations/verify-manifest.mjs
node scripts/agent-enrollment/verify-candidate.mjs
node scripts/telemetry-ingestion/verify-candidate.mjs
node scripts/telemetry-quota/verify-candidate.mjs
node scripts/telemetry-agent-quota/verify-candidate.mjs
node scripts/telemetry-auth-outcome/verify-candidate.mjs
node scripts/telemetry-maintenance/verify-candidate.mjs
node scripts/telemetry-maintenance/verify-contention-candidate.mjs
node scripts/telemetry-maintenance/verify-operations-candidate.mjs
node --test scripts/telemetry-maintenance/controlled-maintenance.test.mjs

ORIGINAL_HASH='3a49fc829b985fefe68616dcc525da83138b18e3d199d18d02817d5751f6b513'
QUOTA_HASH='4cce6ab1a31d4f0f323e6c5ad380b46fc21f1611198b44cf914b74118e29afe8'
QUOTA_SQL='scripts/telemetry-quota/migrations/0001_telemetry_network_quota.sql'
AGENT_SQL='scripts/telemetry-agent-quota/migrations/0001_telemetry_agent_quota.sql'
AGENT_HASH='a90ec4b3c0b83c53b147d0160ab589cf673bfb032898b46075ce9c0b28f5f012'
[[ "$(sha256sum "$AGENT_SQL" | cut -d' ' -f1)" == "$AGENT_HASH" ]] ||
  refuse 'Agent migration source changed'
[[ "$(sha256sum "$QUOTA_SQL" | cut -d' ' -f1)" == "$QUOTA_HASH" ]] ||
  refuse 'Quota migration source changed'

PG_BIN="$(pg_config --bindir)"
for bin in initdb pg_ctl postgres psql createdb; do
  [[ -x "$PG_BIN/$bin" ]] || refuse "Missing PostgreSQL server binary: $PG_BIN/$bin"
done

[[ "$(id -un)" =~ ^[a-z_][a-z0-9_-]*$ ]] || refuse 'Unexpected local username'
[[ "$(id -gn)" =~ ^[a-z_][a-z0-9_-]*$ ]] || refuse 'Unexpected local group'

BASE=''
DATA=''
SOCKET=''
PORT=55432
PROBE=''
INSTALL_D15B=''
INSTALL_QUOTA=''
AGENT_PROBE=''
AGENT_INSTALL=''
AUTH_PROBE=''
AUTH_INSTALL=''
RETENTION_PROBE=''
RETENTION_INSTALL=''

cleanup() {
  local code=$? server_alive=0
  trap - EXIT
  set +e
  for temp in "$PROBE" "$INSTALL_D15B" "$INSTALL_QUOTA"; do
    if [[ "$temp" =~ ^/tmp/pulse-d15c3c-(rollback|d15b|quota)-[A-Za-z0-9]{8}[.]sql$ ]]; then
      rm -f -- "$temp" || code=1
    fi
  done

  for temp in "$AGENT_PROBE" "$AGENT_INSTALL"; do
    if [[ "$temp" =~ ^/tmp/pulse-d15c4-(rollback|install)-[A-Za-z0-9]{8}[.]sql$ ]]; then
      rm -f -- "$temp" || code=1
    fi
  done

  for temp in "$AUTH_PROBE" "$AUTH_INSTALL"; do
    if [[ "$temp" =~ ^/tmp/pulse-d15c4e-(rollback|install)-[A-Za-z0-9]{8}[.]sql$ ]]; then
      rm -f -- "$temp" || code=1
    fi
  done

  for temp in "$RETENTION_PROBE" "$RETENTION_INSTALL"; do
    if [[ "$temp" =~ ^/tmp/pulse-d15c5a-(rollback|install)-[A-Za-z0-9]{8}[.]sql$ ]]; then
      rm -f -- "$temp" || code=1
    fi
  done

  if [[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] &&
     sudo -u postgres test -f "$BASE/.pulse-telemetry-quota-marker"; then
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null 2>&1 ||
      sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || true
    fi
    if sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      server_alive=1
    fi
    if [[ "$server_alive" -eq 0 ]]; then
      sudo -u postgres rm -rf -- "$BASE" || code=1
      echo 'PASS: disposable quota PostgreSQL cluster removed'
    else
      echo "CRITICAL: isolated cluster may still be running at $BASE" >&2
      code=1
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE="$(sudo -u postgres mktemp -d /tmp/pulse-replay-XXXXXXXXXX)"
[[ "$BASE" =~ ^/tmp/pulse-replay-[A-Za-z0-9]{10}$ ]] ||
  refuse 'Unexpected temporary data directory path'
DATA="$BASE/data"
SOCKET="$BASE/socket"
sudo -u postgres touch "$BASE/.pulse-telemetry-quota-marker"
sudo -u postgres touch "$BASE/.pulse-telemetry-agent-quota-marker"
sudo -u postgres mkdir -m 0700 "$DATA"
sudo -u postgres mkdir -m 0755 "$SOCKET"
sudo chgrp "$(id -gn)" "$BASE" "$SOCKET"
sudo -u postgres chmod 0750 "$BASE" "$SOCKET"

echo '========== INITIALIZE ISOLATED POSTGRESQL =========='
sudo -u postgres "$PG_BIN/initdb" -D "$DATA" \
  --username=postgres --auth-local=peer --auth-host=reject \
  --no-instructions >/dev/null

sudo -u postgres tee "$DATA/pg_ident.conf" >/dev/null <<IDENT
pulse_release $(id -un) pulse_metrics_migrator
pulse_release $(id -un) pulse_metrics_app
pulse_release $(id -un) pulse_metrics_test_fixture
pulse_release $(id -un) pulse_metrics_test_maintainer
IDENT
sudo -u postgres tee "$DATA/pg_hba.conf" >/dev/null <<'HBA'
local all postgres peer
local pulse_metrics pulse_metrics_migrator peer map=pulse_release
local pulse_metrics pulse_metrics_app peer map=pulse_release
local pulse_metrics pulse_metrics_test_fixture peer map=pulse_release
local pulse_metrics pulse_metrics_test_maintainer peer map=pulse_release
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

sudo -u postgres "$PG_BIN/pg_ctl" -D "$DATA" -l "$BASE/start.log" -w start >/dev/null

psql_admin() {
  local db="$1"; shift
  sudo -u postgres "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -P pager=off \
    -h "$SOCKET" -p "$PORT" -U postgres -d "$db" "$@"
}

IDENTITY="$(psql_admin postgres -Atq -c "
  SELECT current_setting('data_directory') || '|' || current_user || '|' ||
  (inet_server_addr() IS NULL)::text || '|' ||
  (current_setting('listen_addresses') = '')::text || '|' ||
  current_setting('unix_socket_directories')
")"
[[ "$IDENTITY" == "$DATA|postgres|true|true|$SOCKET" ]] ||
  refuse 'Disposable PostgreSQL target identity mismatch'
echo 'PASS: exact disposable PostgreSQL data directory; Unix socket only; TCP off'

echo '========== REPLAY HISTORICAL DATABASE FOUNDATION =========='
psql_admin postgres -q < scripts/replay/bootstrap-roles.sql
sudo -u postgres "$PG_BIN/createdb" -h "$SOCKET" -p "$PORT" \
  -U postgres -O postgres pulse_metrics
psql_admin pulse_metrics -q < scripts/replay/bootstrap-database.sql

PULSE_REPLAY_SOCKET="$SOCKET" PULSE_REPLAY_DATA="$DATA" \
PULSE_REPLAY_PORT="$PORT" node scripts/replay/migrate-isolated.mjs
psql_admin pulse_metrics -q < scripts/replay/runtime-grants.sql
psql_admin pulse_metrics -q < scripts/migrations/ledger-bootstrap.sql

STEPS="$(node scripts/migrations/verify-manifest.mjs --tsv)"
[[ "$(printf '%s\n' "$STEPS" | wc -l)" -eq 6 ]] ||
  refuse 'Historical privileged migration count changed'
while IFS=$'\t' read -r version source digest; do
  [[ "$version" =~ ^00[1-6]$ ]] || refuse 'Unexpected migration version'
  [[ "$source" =~ ^scripts/admin/00[1-6]_[a-z_]+[.]sql$ ]] ||
    refuse 'Unexpected privileged migration source path'
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || refuse 'Invalid pinned source digest'
  {
    printf 'BEGIN READ ONLY;\n'
    printf "SELECT set_config('pulse.replay_step_version','%s',true);\n" "$version"
    cat scripts/migrations/step-preflight-assert.sql
    printf 'COMMIT;\n'
  } | psql_admin pulse_metrics -q >/dev/null
  psql_admin pulse_metrics -q < "$source"
  psql_admin pulse_metrics -q -v "version=$version" \
    -v "source_path=$source" -v "digest=$digest" \
    < scripts/migrations/ledger-record.sql
  echo "PASS: protected historical migration $version"
done <<< "$STEPS"
psql_admin pulse_metrics -q < scripts/migrations/ledger-audit.sql
psql_admin pulse_metrics -q < scripts/audit/migration-security-invariants.sql
psql_admin pulse_metrics -q \
  < scripts/agent-enrollment/migrations/0001_agent_enrollment.sql

echo '========== INSTALL PINNED D15B INGESTION IN DISPOSABLE CLUSTER =========='
INSTALL_D15B="$(mktemp /tmp/pulse-d15c3c-d15b-XXXXXXXX.sql)"
node scripts/telemetry-ingestion/emit-reviewed-sql.mjs > "$INSTALL_D15B"
[[ "$(sha256sum "$INSTALL_D15B" | cut -d' ' -f1)" == "$ORIGINAL_HASH" ]] ||
  refuse 'D15B installation bytes changed'
psql_admin pulse_metrics -q < "$INSTALL_D15B"
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql
rm -f -- "$INSTALL_D15B"; INSTALL_D15B=''
echo 'PASS: existing locked D15B installation and permission audit'

echo '========== TEST D15C-3B MIGRATION ATOMIC ROLLBACK =========='
PROBE="$(mktemp /tmp/pulse-d15c3c-rollback-XXXXXXXX.sql)"
python3 - "$QUOTA_SQL" "$PROBE" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text(encoding='utf8')
end = '\nCOMMIT;\n'
if not source.endswith(end) or source.count('\nCOMMIT;') != 1:
    raise SystemExit('REFUSE: unexpected SQL transaction ending')
fail = "\nDO $forced$ BEGIN RAISE EXCEPTION 'D15C_QUOTA_EXPECTED_ROLLBACK'; END $forced$;\n"
Path(sys.argv[2]).write_text(source[:-len(end)] + fail + end, encoding='utf8')
PY
if ROLLBACK_OUTPUT="$(psql_admin pulse_metrics -q < "$PROBE" 2>&1)"; then
  refuse 'Deliberately broken quota migration unexpectedly committed'
fi
[[ "$ROLLBACK_OUTPUT" == *'D15C_QUOTA_EXPECTED_ROLLBACK'* ]] ||
  refuse 'Migration failed for wrong reason during rollback rehearsal'
psql_admin pulse_metrics -Atq -c "
  DO \$verify\$ BEGIN
    IF to_regnamespace('pulse_telemetry_quota') IS NOT NULL OR
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pulse_metrics_telemetry_quota_executor')
    THEN RAISE EXCEPTION 'Quota schema/role survived atomic rollback'; END IF;
  END; \$verify\$;
" >/dev/null
rm -f -- "$PROBE"; PROBE=''
echo 'PASS: intentionally aborted migration rolled back every security object'

echo '========== INSTALL PINNED QUOTA MIGRATION IN DISPOSABLE CLUSTER =========='
node scripts/telemetry-quota/verify-candidate.mjs
INSTALL_QUOTA="$(mktemp /tmp/pulse-d15c3c-quota-XXXXXXXX.sql)"
cat -- "$QUOTA_SQL" > "$INSTALL_QUOTA"
[[ "$(sha256sum "$INSTALL_QUOTA" | cut -d' ' -f1)" == "$QUOTA_HASH" ]] ||
  refuse 'Captured quota SQL bytes do not match reviewed fingerprint'
psql_admin pulse_metrics -q < "$INSTALL_QUOTA"
echo 'PASS: pinned quota candidate installed only in temporary database'

psql_admin pulse_metrics -q <<'SQL'
DO $verify$
BEGIN
  IF (SELECT count(*) FROM pulse_telemetry_quota.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_quota.schema_migrations
                    WHERE version='0001')
     OR NOT EXISTS (
       SELECT 1 FROM pg_class WHERE oid='pulse_telemetry_quota.network_buckets'::regclass
       AND relrowsecurity AND relforcerowsecurity
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid='pulse_telemetry_quota.consume_network_quota(text)'::regprocedure
       AND prosecdef
       AND proowner = 'pulse_metrics_telemetry_quota_executor'::regrole
     )
     OR has_any_column_privilege('pulse_metrics_app',
            'pulse_telemetry_quota.network_buckets','SELECT')
     OR has_any_column_privilege('pulse_metrics_app',
            'pulse_telemetry_quota.network_buckets','INSERT')
     OR has_any_column_privilege('pulse_metrics_app',
            'pulse_telemetry_quota.network_buckets','UPDATE')
  THEN RAISE EXCEPTION 'Quota protected ledger/RLS/owner/runtime privileges invalid';
  END IF;
END;
$verify$;
SQL

echo '========== VERIFY DUPLICATE MIGRATION REFUSED =========='
if REAPPLY="$(psql_admin pulse_metrics -q < "$INSTALL_QUOTA" 2>&1)"; then
  refuse 'Quota migration unexpectedly reapplied'
fi
[[ "$REAPPLY" == *'REFUSE_D15C_QUOTA'* ]] ||
  refuse 'Duplicate application rejected for unexpected reason'
echo 'PASS: migration cannot be reinstalled over existing quota security objects'

echo '========== RESTRICTED-RUNTIME FUNCTIONAL AND CONCURRENT TESTS =========='
PULSE_TELEMETRY_QUOTA_DISPOSABLE_ONLY=YES \
PULSE_TELEMETRY_QUOTA_SOCKET="$SOCKET" \
PULSE_TELEMETRY_QUOTA_DATA="$DATA" \
  timeout 180s node scripts/telemetry-quota/quota-integration.mjs --normal

COUNT="$(psql_admin pulse_metrics -Atq -c \
  "SELECT count(*) FROM pulse_telemetry_quota.network_buckets")"
[[ "$COUNT" == '3' ]] || refuse "Unexpected quota test bucket count: $COUNT"
psql_admin pulse_metrics -q -c "
  UPDATE pulse_telemetry_quota.network_buckets
  SET window_end = clock_timestamp() - interval '2 seconds'
  WHERE bucket_digest = repeat('a',64) AND attempts = 1201
" >/dev/null
PULSE_TELEMETRY_QUOTA_DISPOSABLE_ONLY=YES \
PULSE_TELEMETRY_QUOTA_SOCKET="$SOCKET" \
PULSE_TELEMETRY_QUOTA_DATA="$DATA" \
  timeout 30s node scripts/telemetry-quota/quota-integration.mjs --rollover
RESET="$(psql_admin pulse_metrics -Atq -c \
  "SELECT attempts FROM pulse_telemetry_quota.network_buckets WHERE bucket_digest=repeat('a',64)")"
[[ "$RESET" == '1' ]] || refuse 'Expired quota bucket did not reset to 1'
echo 'PASS: quota expiry/reset behavior verified'

psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql
rm -f -- "$INSTALL_QUOTA"; INSTALL_QUOTA=''
echo 'PASS: D15B security unchanged after quota migration'
echo '========== D15C-4B ATOMIC MIGRATION ROLLBACK =========='
AGENT_PROBE="$(mktemp /tmp/pulse-d15c4-rollback-XXXXXXXX.sql)"
python3 - "$AGENT_SQL" "$AGENT_PROBE" <<'PYROLLBACK4'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text(encoding='utf8')
ending = '\nCOMMIT;\n'
if not source.endswith(ending) or source.count('\nCOMMIT;') != 1:
    raise SystemExit('REFUSE_D15C4: unreviewed transaction boundary')
failure = (
    "\nDO $forced4$ BEGIN RAISE EXCEPTION 'D15C4_EXPECTED_ROLLBACK'; "
    "END $forced4$;\n"
)
Path(sys.argv[2]).write_text(source[:-len(ending)] + failure + ending, encoding='utf8')
PYROLLBACK4

if AGENT_ABORT="$(psql_admin pulse_metrics -q < "$AGENT_PROBE" 2>&1)"; then
  refuse 'Agent quota forced-failure migration unexpectedly committed'
fi
[[ "$AGENT_ABORT" == *'D15C4_EXPECTED_ROLLBACK'* ]] ||
  refuse 'Unexpected failure reason in agent migration rollback'
psql_admin pulse_metrics -q <<'SQLROLLBACK4'
DO $verify$
DECLARE v_hash text;
BEGIN
  IF to_regnamespace('pulse_telemetry_agent_quota') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_roles
        WHERE rolname='pulse_metrics_telemetry_agent_quota_executor') THEN
    RAISE EXCEPTION 'Agent quota objects survived atomic rollback';
  END IF;
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')
  INTO v_hash FROM pg_catalog.pg_proc p
  WHERE p.oid='pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'::regprocedure;
  IF v_hash IS DISTINCT FROM '588783991e63bc975f774692fc6732c80ac2e9070b33c93bea43c503e31f2f1f' THEN
    RAISE EXCEPTION 'Original D15B function was modified despite rollback';
  END IF;
END;
$verify$;
SQLROLLBACK4
rm -f -- "$AGENT_PROBE"; AGENT_PROBE=''
echo 'PASS: forced migration failure rolled back function replacement, table, role and receipt'

echo '========== INSTALL PINNED AUTHENTICATED AGENT QUOTA =========='
node scripts/telemetry-agent-quota/verify-candidate.mjs
AGENT_INSTALL="$(mktemp /tmp/pulse-d15c4-install-XXXXXXXX.sql)"
cat -- "$AGENT_SQL" > "$AGENT_INSTALL"
[[ "$(sha256sum "$AGENT_INSTALL" | cut -d' ' -f1)" == "$AGENT_HASH" ]] ||
  refuse 'Captured agent quota SQL differs from locked candidate'
psql_admin pulse_metrics -q < "$AGENT_INSTALL"
echo 'PASS: reviewed agent quota SQL installed in disposable cluster only'

if REAPPLY4="$(psql_admin pulse_metrics -q < "$AGENT_INSTALL" 2>&1)"; then
  refuse 'Agent quota migration replay unexpectedly accepted'
fi
[[ "$REAPPLY4" == *'REFUSE_D15C4'* ]] ||
  refuse 'Duplicate agent quota installation denied for unexpected reason'
echo 'PASS: duplicate agent quota installation blocked'

psql_admin pulse_metrics -q <<'SQLAUDIT4'
DO $audit$
DECLARE v_role record;
BEGIN
  IF (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations
                    WHERE version='0001')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
         WHERE oid='pulse_telemetry_agent_quota.agent_buckets'::regclass
           AND relrowsecurity AND relforcerowsecurity)
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_agent_quota','USAGE')
     OR has_table_privilege('pulse_metrics_app','pulse_telemetry_agent_quota.agent_buckets','SELECT')
     OR has_function_privilege('pulse_metrics_app',
          'pulse_telemetry_agent_quota.consume_new_submission(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege('pulse_metrics_telemetry_executor',
          'pulse_telemetry_agent_quota.consume_new_submission(uuid,uuid)','EXECUTE')
     OR pg_has_role('pulse_metrics_app',
          'pulse_metrics_telemetry_agent_quota_executor','MEMBER')
  THEN RAISE EXCEPTION 'Agent quota permissions/ledger/RLS regression';
  END IF;
  SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit
    INTO v_role FROM pg_roles
    WHERE rolname='pulse_metrics_telemetry_agent_quota_executor';
  IF NOT FOUND OR v_role.rolcanlogin OR v_role.rolsuper
     OR NOT v_role.rolbypassrls OR v_role.rolinherit THEN
    RAISE EXCEPTION 'Agent quota function role configuration invalid';
  END IF;
END;
$audit$;
SQLAUDIT4

echo '========== CREATE SYNTHETIC CUSTOMER AND AGENT FIXTURES =========='
psql_admin pulse_metrics -q <<'SQLFIXTURES4'
BEGIN;
SELECT public.resolve_workos_user('user_agent_owner_a');
SELECT public.resolve_workos_user('user_agent_owner_b');
SELECT * FROM public.create_workos_organization(
  'user_agent_owner_a','D15C4 Synthetic Customer A','pulse-d15c4-agent-a'
);
SELECT * FROM public.create_workos_organization(
  'user_agent_owner_b','D15C4 Synthetic Customer B','pulse-d15c4-agent-b'
);
COMMIT;
SQLFIXTURES4
ORG_A="$(psql_admin pulse_metrics -Atq -c   "SELECT id FROM public.organizations WHERE slug='pulse-d15c4-agent-a'")"
ORG_B="$(psql_admin pulse_metrics -Atq -c   "SELECT id FROM public.organizations WHERE slug='pulse-d15c4-agent-b'")"
[[ "$ORG_A" =~ ^[0-9a-f-]{36}$ && "$ORG_B" =~ ^[0-9a-f-]{36}$ &&
   "$ORG_A" != "$ORG_B" ]] || refuse 'Synthetic organization fixture mismatch'

echo '========== RESTRICTED-RUNTIME AUTHORIZATION AND CONCURRENCY =========='
PULSE_D15C4_DISPOSABLE_ONLY=YES \
PULSE_D15C4_SOCKET="$SOCKET" \
PULSE_D15C4_DATA="$DATA" \
PULSE_D15C4_ORG_A="$ORG_A" \
PULSE_D15C4_ORG_B="$ORG_B" \
  timeout 180s node scripts/telemetry-agent-quota/agent-quota-integration.mjs

psql_admin pulse_metrics -q <<'SQLFINAL4'
DO $assert$
DECLARE v_attempts bigint[];
BEGIN
  SELECT array_agg(attempts ORDER BY attempts) INTO v_attempts
  FROM pulse_telemetry_agent_quota.agent_buckets;
  IF v_attempts IS DISTINCT FROM ARRAY[2,3,136]::bigint[] THEN
    RAISE EXCEPTION 'Unexpected authenticated agent quota accounting';
  END IF;
  IF (SELECT count(*) FROM public.telemetry_samples) <> 124 THEN
    RAISE EXCEPTION 'Quota denied request inserted telemetry unexpectedly';
  END IF;
  IF (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 124 THEN
    RAISE EXCEPTION 'Quota denied request changed submission ledger';
  END IF;
  RAISE NOTICE 'PASS: 3 independent agent buckets, 124 rows, durable denied counters';
END;
$assert$;
SQLFINAL4

psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql
rm -f -- "$AGENT_INSTALL"; AGENT_INSTALL=''
echo 'PASS: D15B protected grants and receipt remain intact after function replacement'
echo '========== D15C-4E AUTHENTICATION OUTCOME PATCH — DISPOSABLE ONLY =========='
# Do NOT install this revision on an ordinary development or production DB.
node scripts/telemetry-auth-outcome/verify-candidate.mjs
AUTH_SQL='scripts/telemetry-auth-outcome/migrations/0002_machine_credential_rejection.sql'
AUTH_EXPECTED='3061f797a7d1fa0dfb335130252c4d89a3d1ee50d263854a22caa2a6c4d8c771'
[[ "$(sha256sum "$AUTH_SQL" | cut -d' ' -f1)" == "$AUTH_EXPECTED" ]] ||
  refuse 'D15C-4E SQL fingerprint mismatch'

# Test forced rollback with a temporary copy of pinned SQL.
AUTH_PROBE="$(mktemp /tmp/pulse-d15c4e-rollback-XXXXXXXX.sql)"
chmod 600 "$AUTH_PROBE"
python3 - "$AUTH_SQL" "$AUTH_PROBE" <<'PYROLLBACK4E'
from pathlib import Path
import sys
s = Path(sys.argv[1]).read_text()
suffix='\nCOMMIT;\n'
if not s.endswith(suffix) or s.count('\nCOMMIT;') != 1:
    raise SystemExit('REFUSE_D15C4E: unexpected SQL boundary')
p = "\nDO $abort$ BEGIN RAISE EXCEPTION 'D15C4E_EXPECTED_ROLLBACK'; END; $abort$;\n"
Path(sys.argv[2]).write_text(s[:-len(suffix)] + p + suffix)
PYROLLBACK4E
if AUTH_FAILED="$(psql_admin pulse_metrics -q < "$AUTH_PROBE" 2>&1)"; then
  refuse 'D15C-4E forced rollback unexpectedly committed'
fi
[[ "$AUTH_FAILED" == *'D15C4E_EXPECTED_ROLLBACK'* ]] ||
  refuse 'Unexpected D15C-4E migration failure'
# Capture the audit result and require BOTH successful SQL execution AND
# the exact expected database value. Never pipe an unchecked SQL error into
# a grep-based success condition. The heredoc MUST begin immediately after
# the command line so no shell control flow becomes untrusted SQL text.
if ! AUTH_ROLLBACK_STATUS="$(
  psql_admin pulse_metrics -Atq <<'SQLVERIFY4EROLLBACK'
BEGIN READ ONLY;
SELECT CASE
 WHEN (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations)=1
  AND NOT EXISTS (
    SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations
    WHERE version='0002'
  )
  AND (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
    FROM pg_proc p WHERE p.oid='pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'::regprocedure)
    ='6ca2ea99b727df12e737593d31a96238d98d81df6d2f461cdbad902002888e28'
 THEN 'rollback_secure' ELSE 'rollback_failed' END;
COMMIT;
SQLVERIFY4EROLLBACK
)"; then
  refuse 'D15C-4E rollback audit SQL execution failed'
fi
[[ "$AUTH_ROLLBACK_STATUS" == 'rollback_secure' ]] ||
  refuse 'D15C-4E failed install changed protected function/ledger'
rm -f -- "$AUTH_PROBE"; AUTH_PROBE=''
echo 'PASS: credential rejection revision rolls back atomically on forced error'

# Capture exactly reviewed bytes to avoid a mutable source stream.
AUTH_INSTALL="$(mktemp /tmp/pulse-d15c4e-install-XXXXXXXX.sql)"
chmod 600 "$AUTH_INSTALL"
cp -- "$AUTH_SQL" "$AUTH_INSTALL"
[[ "$(sha256sum "$AUTH_INSTALL" | cut -d' ' -f1)" == "$AUTH_EXPECTED" ]] ||
  refuse 'D15C-4E captured migration artifact changed'
psql_admin pulse_metrics -q < "$AUTH_INSTALL"
rm -f -- "$AUTH_INSTALL"; AUTH_INSTALL=''
echo 'PASS: explicit machine credential rejection installed in temporary database'

if AUTH_REAPPLY="$(psql_admin pulse_metrics -q < "$AUTH_SQL" 2>&1)"; then
  refuse 'D15C-4E duplicate migration unexpectedly succeeded'
fi
[[ "$AUTH_REAPPLY" == *'REFUSE_D15C4E: unexpected migration baseline or replay'* ]] ||
  refuse 'D15C-4E duplicate migration rejected for unexpected reason'
echo 'PASS: replay of D15C-4E migration refused'

psql_admin pulse_metrics -q <<'SQLAUTHSECURITY4E'
DO $audit$
DECLARE v_hash text;
BEGIN
  SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
    INTO v_hash FROM pg_proc p
    WHERE p.oid='pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'::regprocedure;
  IF v_hash <> '04abf246ad3c10b3352c2cc52165a70c5f736d2280452bb4e0c02d84e04774e2'
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR NOT EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.schema_migrations WHERE version='0002')
     OR has_table_privilege('pulse_metrics_app','public.agent_credentials','SELECT')
     OR has_any_column_privilege('pulse_metrics_app','public.telemetry_samples','INSERT')
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_agent_quota','USAGE')
  THEN RAISE EXCEPTION 'D15C4E updated function or private permissions invalid';
  END IF;
  RAISE NOTICE 'PASS: D15C-4E private receipt, function fingerprint and ACLs verified';
END;
$audit$;
SQLAUTHSECURITY4E
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql

echo '========== D15C-4E REAL POSTGRESQL -> GATEWAY -> HTTP =========='
PULSE_D15C4_DISPOSABLE_ONLY=YES \
PULSE_D15C4_SOCKET="$SOCKET" \
PULSE_D15C4_DATA="$DATA" \
PULSE_D15C4_ORG_A="$ORG_A" \
PULSE_D15C4_ORG_B="$ORG_B" \
  timeout --signal=TERM --kill-after=10s 180s \
  node --import tsx scripts/telemetry-agent-quota/http-postgres-integration.ts

psql_admin pulse_metrics -q <<'SQLFINAL4D'
DO $assert$
DECLARE
  v_total bigint;
  v_agents bigint;
  v_attempts bigint[];
BEGIN
  SELECT count(*) INTO v_total FROM public.telemetry_samples;
  SELECT count(*) INTO v_agents FROM pulse_telemetry_ingestion.submissions;
  IF v_total <> 244 OR v_agents <> 244 THEN
    RAISE EXCEPTION 'D15C4D unexpected persisted telemetry count';
  END IF;
  IF (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets) <> 5 THEN
    RAISE EXCEPTION 'D15C4D unexpected agent quota bucket count';
  END IF;
  SELECT array_agg(attempts ORDER BY attempts) INTO v_attempts
  FROM pulse_telemetry_agent_quota.agent_buckets;
  IF v_attempts IS DISTINCT FROM ARRAY[1,2,3,125,136]::bigint[] THEN
    RAISE EXCEPTION 'D15C4D unexpected persistent per-agent counters';
  END IF;
  RAISE NOTICE 'PASS: verified HTTP inserts persisted, denial counters survived, tenants independent';
END;
$assert$;
SQLFINAL4D

psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql


echo '========== D15C-5A BOUNDED QUOTA RETENTION: ROLLBACK =========='
RETENTION_SQL='scripts/telemetry-maintenance/migrations/0001_telemetry_quota_retention.sql'
RETENTION_HASH='5c8626cea57c4238698882b7260112cea1adfe017866af39ba14a2ffb39ddc5e'
node scripts/telemetry-maintenance/verify-candidate.mjs
[[ "$(sha256sum "$RETENTION_SQL" | cut -d' ' -f1)" == "$RETENTION_HASH" ]] ||
  refuse 'D15C-5A reviewed SQL fingerprint mismatch'

RETENTION_PROBE="$(mktemp /tmp/pulse-d15c5a-rollback-XXXXXXXX.sql)"
chmod 600 "$RETENTION_PROBE"
python3 - "$RETENTION_SQL" "$RETENTION_PROBE" <<'PYROLLBACK5A'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text(encoding='utf8')
ending = '\nCOMMIT;\n'
if not source.endswith(ending) or source.count('\nCOMMIT;') != 1:
    raise SystemExit('REFUSE_D15C5A: unexpected SQL transaction boundary')
probe = (
    "\nDO $abort5a$ BEGIN RAISE EXCEPTION "
    "'D15C5A_EXPECTED_ROLLBACK'; END; $abort5a$;\n"
)
Path(sys.argv[2]).write_text(source[:-len(ending)] + probe + ending, encoding='utf8')
PYROLLBACK5A

if RETENTION_ABORT="$(psql_admin pulse_metrics -q < "$RETENTION_PROBE" 2>&1)"; then
  refuse 'D15C-5A forced rollback unexpectedly committed'
fi
[[ "$RETENTION_ABORT" == *'D15C5A_EXPECTED_ROLLBACK'* ]] ||
  refuse 'D15C-5A forced failure did not reach expected rollback marker'

# Execute SQL and compare its exact data value; do not accept a failed psql
# process as proof of rollback (a prior D15C-4E test caught this mistake).
if ! RETENTION_ROLLBACK_STATE="$(
  psql_admin pulse_metrics -Atq <<'SQLVERIFY5A'
BEGIN READ ONLY;
SELECT CASE
  WHEN to_regnamespace('pulse_telemetry_maintenance') IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM pg_roles
     WHERE rolname='pulse_metrics_telemetry_maintenance_executor'
   )
   AND (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations)=2
   AND (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
        FROM pg_proc p
        WHERE p.oid='pulse_telemetry_ingestion.ingest_submission(text,uuid,text,timestamptz,integer,real,real,real,bigint,bigint,jsonb)'::regprocedure)
       = '04abf246ad3c10b3352c2cc52165a70c5f736d2280452bb4e0c02d84e04774e2'
  THEN 'rollback_secure' ELSE 'rollback_failed' END;
COMMIT;
SQLVERIFY5A
)"; then
  refuse 'D15C-5A rollback verification query failed'
fi
[[ "$RETENTION_ROLLBACK_STATE" == 'rollback_secure' ]] ||
  refuse 'D15C-5A rollback left objects or changed protected function'
rm -f -- "$RETENTION_PROBE"; RETENTION_PROBE=''
echo 'PASS: forced D15C-5A failure left no maintenance objects, role or receipt'

echo '========== D15C-5A PINNED INSTALLATION: DISPOSABLE ONLY =========='
RETENTION_INSTALL="$(mktemp /tmp/pulse-d15c5a-install-XXXXXXXX.sql)"
chmod 600 "$RETENTION_INSTALL"
cp -- "$RETENTION_SQL" "$RETENTION_INSTALL"
[[ "$(sha256sum "$RETENTION_INSTALL" | cut -d' ' -f1)" == "$RETENTION_HASH" ]] ||
  refuse 'Captured D15C-5A installation bytes changed'
psql_admin pulse_metrics -q < "$RETENTION_INSTALL"
echo 'PASS: pinned maintenance migration installed in disposable cluster'

if RETENTION_REAPPLY="$(psql_admin pulse_metrics -q < "$RETENTION_INSTALL" 2>&1)"; then
  refuse 'D15C-5A duplicate migration unexpectedly succeeded'
fi
[[ "$RETENTION_REAPPLY" == *'REFUSE_D15C5A:'* ]] ||
  refuse 'D15C-5A duplicate migration refused for an unexpected reason'
rm -f -- "$RETENTION_INSTALL"; RETENTION_INSTALL=''
echo 'PASS: duplicate maintenance migration rejected before modifications'

psql_admin pulse_metrics -q <<'SQLSECURITY5A'
BEGIN READ ONLY;
DO $audit$
DECLARE v_role record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit
    INTO v_role FROM pg_roles
  WHERE rolname='pulse_metrics_telemetry_maintenance_executor';
  IF NOT FOUND OR v_role.rolcanlogin OR v_role.rolsuper
     OR NOT v_role.rolbypassrls OR v_role.rolinherit
     OR has_schema_privilege('pulse_metrics_app','pulse_telemetry_maintenance','USAGE')
     OR has_function_privilege('pulse_metrics_app',
          'pulse_telemetry_maintenance.prune_expired_quota_buckets()','EXECUTE')
     OR has_table_privilege('pulse_metrics_app',
          'pulse_telemetry_quota.network_buckets','DELETE')
     OR has_table_privilege('pulse_metrics_app',
          'pulse_telemetry_agent_quota.agent_buckets','DELETE')
     OR pg_has_role('pulse_metrics_app',
          'pulse_metrics_telemetry_maintenance_executor','MEMBER')
     OR (SELECT count(*) FROM pulse_telemetry_maintenance.schema_migrations) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_class
          WHERE oid='pulse_telemetry_maintenance.schema_migrations'::regclass
          AND relrowsecurity AND relforcerowsecurity)
  THEN RAISE EXCEPTION 'D15C5A function/role/private ledger security failure';
  END IF;
END;
$audit$;
COMMIT;
SQLSECURITY5A

echo '========== D15C-5A RUNTIME ACCESS DENIED =========='
PULSE_D15C5A_DISPOSABLE_ONLY=YES \
PULSE_D15C5A_SOCKET="$SOCKET" \
PULSE_D15C5A_DATA="$DATA" \
  timeout 30s node scripts/telemetry-maintenance/retention-runtime-negative.mjs

echo '========== D15C-5A SYNTHETIC EXPIRY AND BATCH LIMITS =========='
# All fixture values are synthetic. NEVER delete or change customer data.
psql_admin pulse_metrics -q <<'SQLFIXTURE5A'
BEGIN;
INSERT INTO pulse_telemetry_quota.network_buckets
  (bucket_digest, attempts, window_end)
SELECT encode(sha256(convert_to('d15c5a-old-network-'||g.n,'UTF8')),'hex'),
       7, clock_timestamp() - interval '4 days'
FROM generate_series(1,265) AS g(n);
INSERT INTO pulse_telemetry_agent_quota.agent_buckets
  (organization_id,agent_id,attempts,window_end)
SELECT gen_random_uuid(), gen_random_uuid(), 7,
       clock_timestamp() - interval '4 days'
FROM generate_series(1,265);
INSERT INTO pulse_telemetry_quota.network_buckets
  (bucket_digest, attempts, window_end)
VALUES
  (encode(sha256(convert_to('d15c5a-active-network','UTF8')),'hex'),
   2, clock_timestamp() + interval '2 minutes'),
  (encode(sha256(convert_to('d15c5a-recent-network','UTF8')),'hex'),
   2, clock_timestamp() - interval '1 hour');
INSERT INTO pulse_telemetry_agent_quota.agent_buckets
  (organization_id,agent_id,attempts,window_end)
VALUES
  (gen_random_uuid(),gen_random_uuid(),2,clock_timestamp()+interval '2 minutes'),
  (gen_random_uuid(),gen_random_uuid(),2,clock_timestamp()-interval '1 hour');
COMMIT;
SQLFIXTURE5A

psql_admin pulse_metrics -q <<'SQLPRECOUNT5A'
BEGIN READ ONLY;
DO $assert$
BEGIN
  IF (SELECT count(*) FROM pulse_telemetry_quota.network_buckets
      WHERE window_end < clock_timestamp()-interval '48 hours')<>265
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets
      WHERE window_end < clock_timestamp()-interval '48 hours')<>265
  THEN RAISE EXCEPTION 'D15C5A synthetic fixture expiry counts incorrect'; END IF;
END;
$assert$;
COMMIT;
SQLPRECOUNT5A

FIRST="$(psql_admin pulse_metrics -Atq -c \
  "SELECT network_removed::text || '|' || agent_removed::text FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()")"
[[ "$FIRST" == '250|250' ]] || refuse "First maintenance batch mismatch: $FIRST"
SECOND="$(psql_admin pulse_metrics -Atq -c \
  "SELECT network_removed::text || '|' || agent_removed::text FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()")"
[[ "$SECOND" == '15|15' ]] || refuse "Second maintenance batch mismatch: $SECOND"
THIRD="$(psql_admin pulse_metrics -Atq -c \
  "SELECT network_removed::text || '|' || agent_removed::text FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()")"
[[ "$THIRD" == '0|0' ]] || refuse "Empty maintenance batch mismatch: $THIRD"
echo 'PASS: exact bounded retention: 250+15+0 expired rows per table'

psql_admin pulse_metrics -q <<'SQLAFTER5A'
BEGIN READ ONLY;
DO $verify$
BEGIN
  IF (SELECT count(*) FROM pulse_telemetry_quota.network_buckets
      WHERE window_end < clock_timestamp() - interval '48 hours') <> 0
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets
      WHERE window_end < clock_timestamp() - interval '48 hours') <> 0
     OR (SELECT count(*) FROM pulse_telemetry_quota.network_buckets) <> 5
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.agent_buckets) <> 7
     OR (SELECT count(*) FROM public.telemetry_samples) <> 244
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 244
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR (SELECT count(*) FROM pulse_telemetry_maintenance.schema_migrations) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pulse_telemetry_quota.network_buckets
       WHERE bucket_digest = encode(sha256(convert_to('d15c5a-active-network','UTF8')),'hex')
     )
     OR NOT EXISTS (
       SELECT 1 FROM pulse_telemetry_quota.network_buckets
       WHERE bucket_digest = encode(sha256(convert_to('d15c5a-recent-network','UTF8')),'hex')
     )
  THEN RAISE EXCEPTION 'D15C5A retention removed active data or altered telemetry'; END IF;
  RAISE NOTICE 'PASS: active/recent quota buckets preserved; telemetry rows and receipts unchanged';
END;
$verify$;
COMMIT;
SQLAFTER5A
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql

echo '========== D15C-5A BOUNDED RETENTION: BASELINE PASSED =========='

# TEST-ONLY, DISPOSABLE LOGIN ROLES. NEVER ADD TO PRODUCT ROLE BOOTSTRAP.
# They simulate a narrowly authorized maintenance caller and fixture operator
# over verified peer-auth Unix sockets. No PostgreSQL TCP listener exists.
echo '========== D15C-5B PREPARE TEST-ONLY CONCURRENCY ROLES =========='
psql_admin pulse_metrics -q <<'SQL5BROLE'
BEGIN;
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('pulse_metrics_test_fixture',
                       'pulse_metrics_test_maintainer')
  ) THEN
    RAISE EXCEPTION 'REFUSE_D15C5B: test-only role already exists';
  END IF;
END;
$guard$;
CREATE ROLE pulse_metrics_test_fixture
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION BYPASSRLS;
CREATE ROLE pulse_metrics_test_maintainer
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;

-- Baseline bootstrap-database.sql intentionally REVOKES CONNECT from PUBLIC.
-- These two synthetic roles therefore cannot open this disposable database
-- unless CONNECT is explicitly granted. Do NOT broaden PUBLIC or app grants.
-- All roles and grants in this section disappear with the temporary cluster.
GRANT CONNECT ON DATABASE pulse_metrics
  TO pulse_metrics_test_fixture, pulse_metrics_test_maintainer;

-- Verify only CONNECT was added. Neither test login may CREATE or TEMP.
DO $database_access_gate$
BEGIN
  IF NOT has_database_privilege(
      'pulse_metrics_test_fixture', 'pulse_metrics', 'CONNECT'
    )
    OR NOT has_database_privilege(
      'pulse_metrics_test_maintainer', 'pulse_metrics', 'CONNECT'
    )
    OR has_database_privilege(
      'pulse_metrics_test_fixture', 'pulse_metrics', 'CREATE'
    )
    OR has_database_privilege(
      'pulse_metrics_test_maintainer', 'pulse_metrics', 'CREATE'
    )
    OR has_database_privilege(
      'pulse_metrics_test_fixture', 'pulse_metrics', 'TEMPORARY'
    )
    OR has_database_privilege(
      'pulse_metrics_test_maintainer', 'pulse_metrics', 'TEMPORARY'
    )
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5B: unsafe disposable test login database rights'
      USING ERRCODE = '42501';
  END IF;
END;
$database_access_gate$;
GRANT USAGE ON SCHEMA pulse_telemetry_quota,
                      pulse_telemetry_agent_quota
  TO pulse_metrics_test_fixture;
GRANT SELECT (bucket_digest, attempts, window_end),
      INSERT (bucket_digest, attempts, window_end),
      UPDATE (window_end)
  ON pulse_telemetry_quota.network_buckets
  TO pulse_metrics_test_fixture;
GRANT SELECT (organization_id, agent_id, attempts, window_end),
      INSERT (organization_id, agent_id, attempts, window_end),
      UPDATE (window_end)
  ON pulse_telemetry_agent_quota.agent_buckets
  TO pulse_metrics_test_fixture;
GRANT USAGE ON SCHEMA pulse_telemetry_maintenance
  TO pulse_metrics_test_maintainer;
GRANT EXECUTE ON FUNCTION
  pulse_telemetry_maintenance.prune_expired_quota_buckets()
  TO pulse_metrics_test_maintainer;
DO $guard2$
BEGIN
  IF pg_has_role('pulse_metrics_app','pulse_metrics_test_fixture','MEMBER')
     OR pg_has_role('pulse_metrics_app',
                    'pulse_metrics_test_maintainer','MEMBER')
     OR pg_has_role('pulse_metrics_app',
                    'pulse_metrics_telemetry_maintenance_executor','MEMBER')
     OR has_table_privilege('pulse_metrics_app',
                            'pulse_telemetry_quota.network_buckets','DELETE')
     OR has_table_privilege('pulse_metrics_app',
                            'pulse_telemetry_agent_quota.agent_buckets','DELETE')
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5B: application maintenance privilege';
  END IF;
END;
$guard2$;
COMMIT;
SQL5BROLE

echo '========== D15C-5B REAL POSTGRESQL CONCURRENT CLEANUP =========='
PULSE_D15C5B_DISPOSABLE_ONLY=YES \
PULSE_D15C5B_SOCKET="$SOCKET" \
PULSE_D15C5B_DATA="$DATA" \
PULSE_D15C5B_ORG_A="$ORG_A" \
  timeout --signal=TERM --kill-after=10s 180s \
  node scripts/telemetry-maintenance/retention-contention-integration.mjs

psql_admin pulse_metrics -q <<'SQL5BPOST'
BEGIN READ ONLY;
DO $audit$
BEGIN
  IF EXISTS (
      SELECT 1 FROM pulse_telemetry_quota.network_buckets
      WHERE window_end < clock_timestamp() - interval '48 hours'
    ) OR EXISTS (
      SELECT 1 FROM pulse_telemetry_agent_quota.agent_buckets
      WHERE window_end < clock_timestamp() - interval '48 hours'
    )
     OR (SELECT count(*) FROM public.telemetry_samples) <> 327
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 327
     OR (SELECT count(*) FROM pulse_telemetry_maintenance.schema_migrations) <> 1
     OR (SELECT count(*) FROM pulse_telemetry_agent_quota.schema_migrations) <> 2
     OR has_schema_privilege('pulse_metrics_app',
          'pulse_telemetry_maintenance', 'USAGE')
     OR has_function_privilege('pulse_metrics_app',
          'pulse_telemetry_maintenance.prune_expired_quota_buckets()',
          'EXECUTE')
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5B: final data or ACL invariant failed';
  END IF;
  RAISE NOTICE 'PASS: 327 genuine synthetic telemetry inserts, receipts and private quota permissions preserved';
END;
$audit$;
COMMIT;
SQL5BPOST
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql

echo '========== D15C-5B DISPOSABLE CONTENTION REHEARSAL: ALL CHECKS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | temporary peer-auth roles only; no scheduler or public endpoint'


echo '========== D15C-5C TEST-ONLY MAINTENANCE OPERATIONS =========='
# `data_directory` is a privileged PostgreSQL setting. Attest the physical
# cluster in this launcher as postgres, not by granting pg_read_all_settings
# to the restricted maintenance test login. Require exact socket/data/port
# binding again immediately before any D15C-5C controller invocation.
if ! D15C5C_PHYSICAL_BINDING="$(psql_admin pulse_metrics -Atq -c "
  SELECT current_database() || '|' || current_user || '|' ||
    current_setting('data_directory') || '|' ||
    current_setting('unix_socket_directories') || '|' ||
    current_setting('port') || '|' ||
    (inet_server_addr() IS NULL)::text || '|' ||
    (current_setting('listen_addresses') = '')::text
")"; then
  refuse 'D15C-5C privileged physical-cluster attestation failed'
fi
[[ "$D15C5C_PHYSICAL_BINDING" == "pulse_metrics|postgres|$DATA|$SOCKET|55432|true|true" ]] ||
  refuse 'D15C-5C privileged physical-cluster identity mismatch'
echo 'PASS: privileged launcher re-attested exact disposable data directory and socket'
# This is a disposable role and Unix-socket test ONLY. Never copy these
# environment variables into real cron, systemd or deployment services.
PULSE_D15C5C_DISPOSABLE_ONLY=YES \
PULSE_D15C5C_SOCKET="$SOCKET" \
PULSE_D15C5C_DATA="$DATA" \
  timeout --signal=TERM --kill-after=10s 120s \
  node scripts/telemetry-maintenance/controlled-maintenance.integration.mjs

echo '========== D15C-5C TEST-ONLY PERMISSION FAILURE =========='
psql_admin pulse_metrics -q <<'SQL5CREVOKE'
REVOKE EXECUTE ON FUNCTION
  pulse_telemetry_maintenance.prune_expired_quota_buckets()
  FROM pulse_metrics_test_maintainer;
SQL5CREVOKE
# A revocation must actually remove EXECUTE for the disposable caller.
# A negative test that accidentally retained its permission is invalid.
if ! D15C5C_EXECUTE_REVOKED="$(psql_admin pulse_metrics -Atq -c "
  SELECT NOT has_function_privilege(
    'pulse_metrics_test_maintainer',
    'pulse_telemetry_maintenance.prune_expired_quota_buckets()',
    'EXECUTE'
  )
")"; then
  refuse 'D15C-5C permission-revocation audit SQL failed'
fi
[[ "$D15C5C_EXECUTE_REVOKED" == 't' ]] ||
  refuse 'D15C-5C maintenance function EXECUTE was not revoked'

if D15C5C_DENIED_OUTPUT="$(
  PULSE_D15C5C_DISPOSABLE_ONLY=YES \
  PULSE_D15C5C_SOCKET="$SOCKET" \
  PULSE_D15C5C_DATA="$DATA" \
  PULSE_D15C5C_DIAGNOSTIC='' \
    timeout --signal=TERM --kill-after=10s 20s \
    node scripts/telemetry-maintenance/controlled-maintenance-cli.mjs 2>&1
)"; then
  refuse 'D15C-5C deliberately revoked maintenance login unexpectedly succeeded'
fi
# The controller correctly emits one safe start event before the privileged
# function is called. When PostgreSQL denies that function, it emits exactly
# one final sanitized failure event. BOTH lines are the reviewed contract.
# Require exact bytes to forbid SQL errors, credentials, paths or diagnostics.
D15C5C_EXPECTED_DENIED_OUTPUT=$'D15C5C_EVENT {"event":"maintenance_started","alert":false}\nD15C5C_EVENT {"event":"maintenance_failed","reason":"operation_unavailable","alert":true}'
[[ "$D15C5C_DENIED_OUTPUT" == "$D15C5C_EXPECTED_DENIED_OUTPUT" ]] ||
  refuse 'D15C-5C revoked permission did not emit exactly the approved sanitized event sequence'
psql_admin pulse_metrics -q <<'SQL5CRESTORE'
GRANT EXECUTE ON FUNCTION
  pulse_telemetry_maintenance.prune_expired_quota_buckets()
  TO pulse_metrics_test_maintainer;
SQL5CRESTORE
echo 'PASS: revoked test-only maintenance permission failed closed with no SQL disclosure'

psql_admin pulse_metrics -q <<'SQL5CPOST'
BEGIN READ ONLY;
DO $audit$
BEGIN
  IF EXISTS (SELECT 1 FROM pulse_telemetry_quota.network_buckets
             WHERE window_end < clock_timestamp() - interval '48 hours')
     OR EXISTS (SELECT 1 FROM pulse_telemetry_agent_quota.agent_buckets
                WHERE window_end < clock_timestamp() - interval '48 hours')
     OR (SELECT count(*) FROM public.telemetry_samples) <> 327
     OR (SELECT count(*) FROM pulse_telemetry_ingestion.submissions) <> 327
     OR (SELECT count(*) FROM pulse_telemetry_maintenance.schema_migrations) <> 1
     OR has_schema_privilege('pulse_metrics_app',
                            'pulse_telemetry_maintenance', 'USAGE')
     OR has_function_privilege('pulse_metrics_app',
       'pulse_telemetry_maintenance.prune_expired_quota_buckets()', 'EXECUTE')
     OR has_table_privilege('pulse_metrics_app',
       'pulse_telemetry_quota.network_buckets','DELETE')
     OR has_table_privilege('pulse_metrics_app',
       'pulse_telemetry_agent_quota.agent_buckets','DELETE')
     OR NOT has_function_privilege('pulse_metrics_test_maintainer',
       'pulse_telemetry_maintenance.prune_expired_quota_buckets()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'REFUSE_D15C5C: post-run security/retention invariant failed'
      USING ERRCODE='42501';
  END IF;
  RAISE NOTICE 'PASS: operational demo preserved 327 telemetry samples, immutable receipts and private ACLs';
END;
$audit$;
COMMIT;
SQL5CPOST
psql_admin pulse_metrics -q < scripts/telemetry-ingestion/release-permission-gate.sql

echo '========== D15C-5C DISPOSABLE OPERATIONS REHEARSAL: ALL CHECKS PASSED =========='
echo 'PUBLIC LAUNCH: NO_GO | review-only, no real operator, scheduler, network or endpoint'
