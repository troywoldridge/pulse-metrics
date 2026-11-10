#!/usr/bin/env bash
# Local-only integration test for narrowly scoped identity provisioning.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo 'ERROR: Missing local .env' >&2
  exit 1
fi
if ! command -v sudo >/dev/null 2>&1; then
  echo 'ERROR: sudo is required for fixture cleanup' >&2
  exit 1
fi

# Never execute fixture writes on a production, remote, or non-runtime DB.
node --env-file=.env --input-type=module <<'NODE'
const raw = process.env.DATABASE_URL;
if (!raw) throw new Error('DATABASE_URL missing');
const url = new URL(raw);
const db = decodeURIComponent(url.pathname.slice(1));
const user = decodeURIComponent(url.username);
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase()) ||
    db !== 'pulse_metrics' || user !== 'pulse_metrics_app' ||
    process.env.NODE_ENV === 'production') {
  throw new Error('Refusing identity test: unsafe database target');
}
console.log('PASS: Local pulse_metrics DB and restricted app role');
NODE

FIXTURE_SUBJECT="user_pulse_identity_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
export FIXTURE_SUBJECT

cleanup() {
  local result=$?
  trap - EXIT
  set +e
  echo 'Cleaning test identity fixture...'
  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off \
    -d pulse_metrics -v fixture_subject="$FIXTURE_SUBJECT" <<'SQL'
DELETE FROM public.users
WHERE auth_provider = 'workos' AND auth_subject = :'fixture_subject';
SQL
  local cleanup_result=$?
  if [[ "$cleanup_result" -ne 0 ]]; then
    echo 'ERROR: fixture cleanup failed' >&2
    exit 1
  fi
  exit "$result"
}
trap cleanup EXIT

echo 'Checking helper function ownership and grants...'
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -P pager=off -d pulse_metrics <<'SQL'
DO $assert$
DECLARE
  role_ok boolean;
  function_ok boolean;
  public_execute boolean;
BEGIN
  SELECT NOT rolcanlogin AND NOT rolsuper AND rolbypassrls AND NOT rolinherit
  INTO role_ok FROM pg_roles WHERE rolname = 'pulse_metrics_identity_executor';
  IF role_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Identity executor role configuration invalid';
  END IF;

  SELECT p.prosecdef AND r.rolname = 'pulse_metrics_identity_executor'
     AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
  INTO function_ok
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = to_regprocedure('public.resolve_workos_user(text)');
  IF function_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Identity function is not securely owned/configured';
  END IF;

  SELECT has_function_privilege('pulse_metrics_app', 'public.resolve_workos_user(text)', 'EXECUTE')
  INTO function_ok;
  IF function_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Runtime role cannot execute helper';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner)))
    WHERE grantee = 0 AND privilege_type = 'EXECUTE'
  ) INTO public_execute
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.resolve_workos_user(text)');
  IF public_execute IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Identity function must not be executable by PUBLIC';
  END IF;

  IF has_table_privilege('pulse_metrics_app','public.users','INSERT')
     OR has_table_privilege('pulse_metrics_app','public.users','UPDATE') THEN
    RAISE EXCEPTION 'Runtime role unexpectedly gained direct user writes';
  END IF;
END;
$assert$;
SQL

node --env-file=.env --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const role = await client.query('SELECT current_user AS role_name');
  assert.equal(role.rows[0].role_name, 'pulse_metrics_app');

  const subject = process.env.FIXTURE_SUBJECT;
  const first = await client.query(
    'SELECT public.resolve_workos_user($1) AS user_id', [subject]
  );
  assert.match(first.rows[0].user_id,
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);

  const second = await client.query(
    'SELECT public.resolve_workos_user($1) AS user_id', [subject]
  );
  assert.equal(second.rows[0].user_id, first.rows[0].user_id);
  console.log('PASS: same verified identity resolves to one internal UUID');

  const unscoped = await client.query(
    'SELECT id FROM public.users WHERE auth_provider = $1 AND auth_subject = $2',
    ['workos', subject]
  );
  assert.equal(unscoped.rowCount, 0);
  console.log('PASS: no tenant context means no ordinary user SELECT');

  await assert.rejects(
    client.query('INSERT INTO public.users(auth_provider, auth_subject) VALUES($1,$2)',
      ['workos', subject + '_direct']),
    (error) => error.code === '42501'
  );
  console.log('PASS: ordinary application role cannot INSERT directly');

  await assert.rejects(
    client.query('SELECT public.resolve_workos_user($1)', ['bad_subject']),
    (error) => error.code === '22023'
  );
  console.log('PASS: malformed provider identity rejected');
} finally {
  await client.end();
}
NODE

echo 'PASS: identity provisioning integration checks complete'
