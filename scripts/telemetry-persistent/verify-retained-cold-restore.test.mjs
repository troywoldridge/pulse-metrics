/** Offline, no PostgreSQL access, regression checks for the retained snapshot restore test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./verify-retained-cold-restore.sh', import.meta.url));
const source = readFileSync(script, 'utf8');
const env = { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '', DATABASE_URL: '', MIGRATION_DATABASE_URL: '', PULSE_APPROVE_5U2F2C_RETAINED_RESTORE: '', PULSE_ENABLE_PUBLIC_INGRESS: '', PULSE_ENABLE_TELEMETRY_SERVICE: '', NODE_TLS_REJECT_UNAUTHORIZED: '1' };
function invoke(args, overrides = {}) {
  return spawnSync('bash', [script, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000 });
}

test('5U-2F2C complete Bash script passes syntax check', () => {
  const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('5U-2F2C refuses missing, extra and invalid modes before any operations', () => {
  for (const args of [[], ['--create'], ['--delete'], ['--plan', '--verify'], ['--verify', 'ignored']]) {
    const r = invoke(args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /REFUSE_D15C5U2F2C/);
    assert.doesNotMatch(r.stdout, /VERIFY ORIGINAL|COPY VERIFIED|START AND SECURITY/);
  }
});

test('5U-2F2C requires a separate exact approval for live restore before touching DB', () => {
  for (const approval of ['', 'YES', 'TEMPORARY_COPY_ONLY', 'COPY_RETAINED_SNAPSHOT_ONLY ']) {
    const r = invoke(['--verify'], { PULSE_APPROVE_5U2F2C_RETAINED_RESTORE: approval });
    assert.notEqual(r.status, 0);
    // The CI container may run as root; that earlier refusal is also correct.
    if (process.getuid?.() === 0) {
      assert.match(r.stderr, /Non-root Linux operator required/);
    } else {
      assert.match(r.stderr, /Explicit retained-copy restore approval required/);
    }
    assert.doesNotMatch(r.stdout, /VERIFY ORIGINAL/);
  }
});

test('5U-2F2C refuses unsafe runtime, inherited URL and production activation', () => {
  for (const change of [
    { NODE_ENV: 'production' }, { NODE_OPTIONS: '--inspect' },
    { DATABASE_URL: 'postgres://localhost/test' },
    { MIGRATION_DATABASE_URL: 'postgres://localhost/test' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { PULSE_ENABLE_PUBLIC_INGRESS: 'YES' },
    { PULSE_ENABLE_TELEMETRY_SERVICE: 'YES' },
  ]) {
    const r = invoke(['--plan'], change);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /REFUSE_D15C5U2F2C/);
    assert.doesNotMatch(r.stdout, /VERIFY ORIGINAL/);
  }
});

test('5U-2F2C pins exact owner-only source, retained snapshot, audit and offline guards', () => {
  assert.match(source, /SOURCE_BASE='\/var\/lib\/postgresql\/pulse-metrics-dev-5u2'/);
  assert.match(source, /BACKUP_BASE='\/var\/lib\/postgresql\/pulse-metrics-dev-5u2-cold-backup-5u2f2b'/);
  assert.match(source, /BACKUP_SCRIPT_SHA='2e4c2d09044e85bc7b20ee3de451b549b958580ccf80c957fcf303bb5414d904'/);
  assert.match(source, /OFFLINE_SHA='7beb99e35afc6b2cd7a898de9d5ee80650e961e1921f29be4c790b47c8beb5ca'/);
  assert.match(source, /VERIFY_SHA='df5aef0ca4d5c1484f8eb22d522a7e8e3b4ff34e8cda8ee3b1b68cc963786883'/);
  assert.match(source, /sudo -u postgres test ! -L "\$SOURCE_BASE\/\.pulse-5u2-ready"/);
  assert.match(source, /bash "\$BACKUP_SCRIPT" --verify/);
});

test('5U-2F2C plan exits before setting up restore sandbox', () => {
  const plan = source.indexOf("if [[ \"$MODE\" == '--plan' ]]");
  const exit = source.indexOf('exit 0', plan);
  const temp = source.indexOf('mktemp -d', plan);
  assert.ok(plan > 0 && exit > plan && temp > exit);
});

test('5U-2F2C copies backup to a distinct owner-only disposable path, with digest identity', () => {
  assert.match(source, /mktemp -d \/tmp\/pulse-retained-restore-5u2-XXXXXXXXXX/);
  assert.match(source, /sudo -u postgres cp -a --reflink=never -- "\$BACKUP_DATA" "\$RESTORE_DATA"/);
  assert.match(source, /\[\[ "\$BACKUP_SHA" =~ \^\[0-9a-f\]\{64\}\$ && "\$BACKUP_SHA" == "\$RESTORE_SHA" \]\]/);
  assert.match(source, /e1348fcee176ff546ae08792379a381329445d982ad40d8bef411839661b3106/);
  assert.match(source, /postgres_directory_is_unlinked "\$BACKUP_DATA\/pg_tblspc"/);
  assert.match(source, /postgres_absent|postgres_path_is_absent/);
});

test('5U-2F2C starts only the disposable copy on distinct private Unix socket with no TCP', () => {
  assert.match(source, /RESTORE_PORT=55435/);
  assert.match(source, /pg_ctl" -D "\$RESTORE_DATA"/);
  assert.match(source, /listen_addresses= -c unix_socket_directories=\$RESTORE_SOCKET/);
  assert.match(source, /-c ssl=off/);
  assert.doesNotMatch(source, /pg_ctl" -D "\$BACKUP_DATA"/);
  assert.doesNotMatch(source, /pg_ctl" -D "\$SOURCE_BASE/);
  assert.match(source, /inet_server_addr\(\) IS NULL/);
});

test('5U-2F2C checks migration receipts, forced RLS, ordinary app denial and zero data twice', () => {
  assert.match(source, /for cycle in 1 2; do/);
  assert.match(source, /BEGIN READ ONLY;/);
  assert.match(source, /relforcerowsecurity/);
  assert.match(source, /pulse_security_migrations\.applied_privileged_steps/);
  assert.match(source, /pulse_telemetry_agent_quota\.schema_migrations/);
  assert.match(source, /SET ROLE pulse_metrics_app; SELECT count\(\*\) FROM public\.agent_credentials/);
  assert.match(source, /'42501:'/);
  assert.match(source, /\(SELECT count\(\*\) FROM public\.telemetry_samples\) <> 0/);
  assert.match(source, /FIRST_FINGERPRINT/);
});

test('5U-2F2C fails closed on failed cleanup, preserves source and revalidates retained copy', () => {
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /restore_path_valid \|\| return 1/);
  assert.match(source, /stop_restored \|\| return 1/);
  assert.match(source, /sudo -u postgres rm -rf -- "\$RESTORE_BASE"/);
  assert.match(source, /bash "\$BACKUP_SCRIPT" --verify \|\| code=1/);
  assert.match(source, /if ! remove_restored; then/);
  assert.match(source, /manual review required/);
  assert.doesNotMatch(source, /rm -rf -- "\$BACKUP_BASE"|rm -rf -- "\$SOURCE_BASE"/);
});
