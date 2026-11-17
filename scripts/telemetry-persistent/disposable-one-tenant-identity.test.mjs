// D15C-5U-2F2K: static + offline fail-closed single-tenant rehearsal tests.
// Never starts PostgreSQL, executes SQL, invokes sudo, or creates a test cluster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const runner = join(here, 'run-disposable-one-tenant-identity.sh');
const stage = join(here, 'disposable-one-tenant-identity-stage.sh');
const fixture = join(here, 'disposable-one-tenant-identity-fixture.sql');
const existingAuditor = join(here, 'read-disposable-pilot-identity.sh');
const existingSql = join(here, 'pilot-identity-evidence.sql');
const source = join(root, 'scripts/test-telemetry-agent-quota-http-rehearsal.sh');
const bash = readFileSync(runner, 'utf8');
const stageText = readFileSync(stage, 'utf8');
const sql = readFileSync(fixture, 'utf8');
const sha = s => createHash('sha256').update(s).digest('hex');
const expectedSourceHash = '79cdbcd0c3c10e5cf79716db96c7c5de61bfcde4b1344bf4f128cce0f6d64de8';
const anchor = "echo '========== CREATE SYNTHETIC CUSTOMER AND AGENT FIXTURES =========='";
const noComments = s => s.split('\n').filter(x => !/^\s*(--|#)/.test(x)).join('\n');
function run(args, env = {}) {
  return spawnSync('bash', [runner, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '', NODE_EXTRA_CA_CERTS: '', ...env },
  });
}

test('complete operator and embedded stage parse; required files exist', () => {
  assert.equal(spawnSync('bash', ['-n', runner], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('bash', ['-n', stage], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('node', ['--check', fileURLToPath(import.meta.url)], { encoding: 'utf8' }).status, 0);
  assert.ok(sql.startsWith('-- D15C-5U-2F2K'));
});

test('plan is strictly informational and does not require PostgreSQL', () => {
  const x = run(['--plan']);
  assert.equal(x.status, 0);
  assert.match(x.stdout, /ONE-TENANT DISPOSABLE REHEARSAL PLAN/);
  assert.match(x.stdout, /55432/);
  assert.match(x.stdout, /NO SIGNING KEY/);
});

test('invalid CLI modes, omitted mode and combined mode refuse before database access', () => {
  for (const args of [[], ['--oops'], ['--plan','--exercise-disposable'], ['--exercise-disposable', '123']]) {
    const x = run(args);
    assert.notEqual(x.status, 0);
    assert.match(x.stderr, /REFUSE_D15C5U2F2K/);
  }
});

test('operator requires explicit safe environment, exact approval and rejects production', () => {
  for (const name of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'DATABASE_URL',
    'MIGRATION_DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER',
    'PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY']) {
    assert.match(bash, new RegExp(name));
  }
  assert.match(bash, /RUN_SYNTHETIC_ONE_TENANT_AND_DESTROY/);
  assert.match(bash, /\$\{NODE_ENV:-development\}.*development/);
  assert.match(bash, /NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.match(bash, /\$EUID.*-ne 0/);
  assert.match(bash, /pg_config --version/);
  assert.match(bash, /PostgreSQL\\ 16/);
  assert.match(bash, /feat\/identity-organization-onboarding/);
});

test('reviewed original full file is pinned to its historical commit and SHA', () => {
  assert.match(bash, /REVIEWED_REF='78e6640'/);
  assert.ok(bash.includes(expectedSourceHash));
  assert.match(bash, /git cat-file -e/);
  assert.match(bash, /cmp -s "\$ORIGINAL" <\(git show/);
  assert.match(bash, /sha256sum -c -/);
});

test('operator never changes or copies original source in place', () => {
  assert.match(bash, /mktemp "\$ROOT\/scripts\/\.pulse-d15c5u2f2k-/);
  assert.match(bash, /anchor = b"echo '========== CREATE SYNTHETIC/);
  assert.match(bash, /compiled = a\.split\(anchor\)\[0\] \+ b'\\n' \+ b \+ b'\\nexit 0\\n'/);
  assert.doesNotMatch(bash, /(?:sed -i|perl -pi|chmod 777|git reset --hard|git clean -fd|CREATE DATABASE|pg_ctl start)/);
});

test('existing reviewed cluster cleanup trap is retained and checked after run', () => {
  assert.match(bash, /b'trap cleanup EXIT'/);
  assert.match(bash, /PASS: disposable quota PostgreSQL cluster removed/);
  assert.match(bash, /grep -Fqx/);
  assert.match(bash, /trap cleanup EXIT/);
  assert.match(bash, /timeout --signal=TERM --kill-after=120s 900s/);
  assert.match(bash, /rm -f -- "\$TMP"/);
  assert.match(bash, /rm -f -- "\$LOG"/);
});

test('fixture SQL allows only guarded PostgreSQL 16 disposable 55432 private socket', () => {
  assert.match(sql, /current_database\(\).*'pulse_metrics'/s);
  assert.match(sql, /current_user <> 'postgres'/);
  assert.match(sql, /server_version_num/);
  assert.match(sql, /current_setting\('port'\) <> '55432'/);
  assert.match(sql, /listen_addresses.*<> ''/);
  assert.match(sql, /data_directory.*pulse-replay-\[A-Za-z0-9\]/);
  assert.match(sql, /unix_socket_directories/);
  assert.match(sql, /inet_server_addr\(\) IS NOT NULL/);
  assert.doesNotMatch(noComments(sql), /55433/);
});

test('synthetic fixture verifies pinned schema, empty identity, no telemetry or loose role privileges', () => {
  for (const re of [/__drizzle_migrations/, /applied_privileged_steps/, /agent_enrollment\.schema_migrations/,
    /telemetry_ingestion\.schema_migrations/, /telemetry_agent_quota\.schema_migrations/,
    /telemetry_quota\.schema_migrations/, /count\(\*\) FROM public\.users/, /count\(\*\) FROM public\.organizations/,
    /count\(\*\) FROM public\.organization_memberships/, /count\(\*\) FROM public\.monitored_agents/,
    /count\(\*\) FROM public\.agent_credentials/, /agent_enrollment_tokens/,
    /public\.audit_events/, /public\.telemetry_samples/, /pulse_telemetry_ingestion\.submissions/,
    /has_table_privilege\('pulse_metrics_app'/, /relforcerowsecurity/]) assert.match(sql, re);
  assert.match(sql, /ROLLBACK|COMMIT/);
});

test('fixture creates only fake owner/org/agent/credential; no redeemable token', () => {
  assert.match(sql, /user_d15c5u2f2k_synthetic_only/);
  assert.match(sql, /resolve_workos_user/);
  assert.match(sql, /create_workos_organization/);
  assert.match(sql, /INSERT INTO public\.monitored_agents/);
  assert.match(sql, /INSERT INTO public\.agent_credentials/);
  assert.match(sql, /sha256\(convert_to\(gen_random_uuid\(\)::text/);
  assert.match(sql, /'\["telemetry:write"\]'::jsonb/);
  assert.doesNotMatch(noComments(sql), /(?:INSERT INTO public\.agent_enrollment_tokens|INSERT INTO public\.telemetry_samples|INSERT INTO pulse_telemetry_ingestion\.submissions|CREATE ROLE|DROP SCHEMA)/i);
});

test('stage installs only pinned 4E on disposable after quota and before fixture', () => {
  assert.match(stageText, /0002_machine_credential_rejection\.sql/);
  assert.match(stageText, /3061f797a7d1fa0dfb335130252c4d89a3d1ee50d263854a22caa2a6c4d8c771/);
  assert.match(stageText, /04abf246ad3c10b3352c2cc52165a70c5f736d2280452bb4e0c02d84e04774e2/);
  assert.match(stageText, /release-permission-gate\.sql/);
  assert.match(stageText, /psql_admin pulse_metrics -q <&8/);
  assert.match(stageText, /sha256sum \/proc\/self\/fd\/8/);
  assert.match(stageText, /read-disposable-pilot-identity\.sh/);
  assert.match(stageText, /--audit-existing-disposable "\$SOCKET"/);
});

test('live negative probes fail closed for owner, agent, credential and surprise user', () => {
  assert.match(stageText, /role='viewer'/);
  assert.match(stageText, /role='owner'/);
  assert.match(stageText, /status='revoked'/);
  assert.match(stageText, /status='active'/);
  assert.match(stageText, /revoked_at=clock_timestamp\(\)/);
  assert.match(stageText, /revoked_at=NULL/);
  assert.match(stageText, /user_d15c5u2f2k_unexpected_extra/);
  assert.match(stageText, /DELETE FROM public\.users/);
  assert.match(stageText, /negative test unexpectedly passed/);
  assert.match(stageText, /negative test failed for unexpected reason/);
});

test('stage explicitly preserves zero-sample identity preflight and no authorization', () => {
  assert.match(stageText, /ONE-TENANT LIVE SQL REHEARSAL: PASS/);
  assert.match(stageText, /NO SIGNING AUTHORITY|NO SIGNER|NO PERSISTENT WRITES/);
  assert.doesNotMatch(noComments(stageText), /55433|\b(?:systemctl|pm2|nginx|cloudflared)\b/);
});

test('existing 2F2J SQL and audit are pinned and not changed by 2F2K', () => {
  assert.match(bash, /e16e24406db1a5a77836a060fbc837d86cac5c355443026feee6e9ec713ba0d9/);
  assert.match(bash, /7e4550ea927fc52994b8d9137d3b6f348389a8f3fbb78c055be4aac78151710b/);
  assert.match(stageText, /e16e24406db1a5a77836a060fbc837d86cac5c355443026feee6e9ec713ba0d9/);
  if (existsSync(existingAuditor)) assert.equal(sha(readFileSync(existingAuditor)),
    'e16e24406db1a5a77836a060fbc837d86cac5c355443026feee6e9ec713ba0d9');
  if (existsSync(existingSql)) assert.equal(sha(readFileSync(existingSql)),
    '7e4550ea927fc52994b8d9137d3b6f348389a8f3fbb78c055be4aac78151710b');
});

test('if original source is present, composed full replacement parses without execution', () => {
  if (!existsSync(source)) return;
  const original = readFileSync(source);
  assert.equal(sha(original), expectedSourceHash);
  const raw = original.toString('utf8');
  assert.equal(raw.split(anchor).length, 2);
  const combined = raw.split(anchor)[0] + '\n' + stageText + '\nexit 0\n';
  const temp = mkdtempSync('/tmp/pulse-2f2k-parse-test-');
  try {
    const path = join(temp, 'generated.sh');
    writeFileSync(path, combined, { mode: 0o600 });
    const parsed = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.ok(combined.includes('trap cleanup EXIT'));
    assert.ok(!combined.includes('user_agent_owner_b'));
    assert.ok(!combined.includes('124 rows'));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
