/** D15C-5U-2E2 offline refusal and invariants for cold backup/restore. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const script = join(dirname(fileURLToPath(import.meta.url)), 'verify-cold-backup-restore.sh');
const source = readFileSync(script, 'utf8');
const clean = {
  ...process.env,
  NODE_OPTIONS: '',
  NODE_ENV: 'development',
  DATABASE_URL: '',
  MIGRATION_DATABASE_URL: '',
  PULSE_APPROVE_5U2E2_COLD_RESTORE: '',
};
function run(args, extra = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8', timeout: 5000, env: { ...clean, ...extra },
  });
}

test('5U-2E2 complete Bash source passes syntax verification', () => {
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('5U-2E2 refuses unknown or missing modes without system operations', () => {
  for (const args of [[], ['--apply'], ['--restore'], ['--verify', '--plan'], ['--unknown']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSE_D15C5U2E2/);
    assert.doesNotMatch(result.stdout, /VERIFY ORIGINAL CLUSTER/);
  }
});

test('5U-2E2 refuses production, runtime injection and inherited DB connection strings', () => {
  const cases = [
    { NODE_ENV: 'production' },
    { NODE_OPTIONS: '--trace-warnings' },
    { DATABASE_URL: 'postgres://example.invalid/db' },
    { MIGRATION_DATABASE_URL: 'postgres://example.invalid/db' },
  ];
  for (const extra of cases) {
    const result = run(['--verify'], extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSE_D15C5U2E2/);
    assert.doesNotMatch(result.stdout, /VERIFY ORIGINAL CLUSTER/);
  }
});

test('5U-2E2 requires a separate exact opt-in before backup or PostgreSQL access', () => {
  for (const value of ['', 'YES', 'TEMPORARY_COPY_ONLY ']) {
    const result = run(['--verify'], { PULSE_APPROVE_5U2E2_COLD_RESTORE: value });
    assert.notEqual(result.status, 0);
    if (process.getuid?.() === 0) {
      assert.match(result.stderr, /Non-root Linux operator required/);
    } else {
      assert.match(result.stderr, /Explicit temporary cold-restore approval required/);
    }
    assert.doesNotMatch(result.stdout, /VERIFY ORIGINAL CLUSTER/);
  }
  assert.match(source, /PULSE_APPROVE_5U2E2_COLD_RESTORE:-/);
});

test('5U-2E2 fixes exact stopped source and distinct temporary restore target', () => {
  assert.match(source, /SOURCE_BASE='\/var\/lib\/postgresql\/pulse-metrics-dev-5u2'/);
  assert.match(source, /RESTORE_PORT=55434/);
  assert.match(source, /mktemp -d \/tmp\/pulse-restore-5u2-XXXXXXXXXX/);
  assert.match(source, /restore_path_valid\(\)/);
  assert.match(source, /listen_addresses= -c unix_socket_directories=\$RESTORE_SOCKET/);
  assert.match(source, /OFFLINE_SHA='[0-9a-f]{64}'/);
  assert.match(source, /PG_VERSION|pg_controldata/);
  assert.doesNotMatch(source, /\b(?:pg_restore|pg_dumpall|pg_dump|initdb|createdb)\b|CREATE ROLE/);
});

test('5U-2E2 rejects linked tablespaces and oversized data before copying', () => {
  assert.match(source, /EXTRA_TABLESPACES/);
  assert.match(source, /UNSAFE_ENTRY/);
  assert.match(source, /SOURCE_BYTES.*1073741824/);
  assert.match(source, /SOURCE_BYTES \* 3/);
  assert.match(source, /cp -a --reflink=never/);
  assert.match(source, /SOURCE_SHA/);
  assert.match(source, /RESTORE_SHA/);
});

test('5U-2E2 audits restoration before reporting success', () => {
  assert.match(source, /BEGIN READ ONLY;/);
  assert.match(source, /forced RLS|FORCE RLS/i);
  assert.match(source, /pulse_metrics_app/);
  assert.match(source, /42501:/);
  assert.match(source, /restore_receipt_fingerprint/);
  assert.match(source, /for cycle in 1 2/);
  assert.match(source, /remove_restored \|\| refuse/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /bash "\$OFFLINE"/);
  assert.match(source, /NO RETAINED BACKUP \| NO PITR/);
});


test('5U-2E2A owner-only source paths are checked under postgres identity', () => {
  assert.match(source, /postgres_directory_is_unlinked\(\)/);
  assert.match(source, /sudo -u postgres test -d "\$1"/);
  assert.match(source, /sudo -u postgres test ! -L "\$1"/);
  assert.match(source, /postgres_directory_is_unlinked "\$SOURCE_DATA\/pg_tblspc"/);
  assert.match(source, /postgres_directory_is_unlinked "\$SOURCE_DATA\/pg_wal"/);
  assert.match(source, /sudo -u postgres find "\$SOURCE_DATA\/pg_tblspc"/);
  assert.doesNotMatch(source, /\[\[ -d "\$SOURCE_DATA\/pg_tblspc"/);
  assert.doesNotMatch(source, /\[\[ -d "\$SOURCE_DATA\/pg_wal"/);
});

test('5U-2E2A temporary owner-only paths and PID checks stay privilege-correct', () => {
  assert.match(source, /postgres_file_is_unlinked\(\)/);
  assert.match(source, /postgres_path_is_absent\(\)/);
  assert.match(source, /postgres_file_is_unlinked "\$RESTORE_BASE\/\.pulse-5u2-restore-marker"/);
  assert.match(source, /postgres_directory_is_unlinked "\$RESTORE_DATA"/);
  assert.match(source, /postgres_path_is_absent "\$RESTORE_DATA\/postmaster\.pid"/);
  assert.doesNotMatch(source, /\[\[ -f "\$RESTORE_BASE\/\.pulse-5u2-restore-marker"/);
  assert.doesNotMatch(source, /\[\[ -d "\$RESTORE_DATA"/);
  assert.doesNotMatch(source, /\[\[ -e "\$RESTORE_DATA\/postmaster\.pid"/);
  assert.match(source, /trap cleanup EXIT/);
});
