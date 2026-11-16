/** D15C-5U-2F2B: offline admission and static security contracts only. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const path = join(dirname(fileURLToPath(import.meta.url)), 'retained-local-cold-snapshot.sh');
const source = readFileSync(path, 'utf8');
const env = {
  ...process.env,
  NODE_ENV: 'development', NODE_OPTIONS: '', DATABASE_URL: '', MIGRATION_DATABASE_URL: '',
  PULSE_APPROVE_5U2F2B_RETAINED_BACKUP: '', PULSE_ENABLE_PUBLIC_INGRESS: '',
  PULSE_ENABLE_TELEMETRY_SERVICE: '', NODE_TLS_REJECT_UNAUTHORIZED: '1',
};
function run(args, extra = {}) {
  return spawnSync('bash', [path, ...args], {
    encoding: 'utf8', timeout: 3000, env: { ...env, ...extra },
  });
}

test('5U-2F2B entire retained snapshot shell file is valid', () => {
  const result = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('5U-2F2B refuses any unknown or multi-argument mode before PostgreSQL access', () => {
  for (const args of [[], ['--apply'], ['--create', '--verify'], ['--restore'], ['--delete'], ['--create', '/tmp/foo']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSE_D15C5U2F2B/);
    assert.doesNotMatch(result.stdout, /OFFLINE CLUSTER STATE|CREATE PRIVATE RETAINED COPY/);
  }
});
test('5U-2F2B refuses unsafe process, database and service environments', () => {
  for (const extra of [
    { NODE_ENV: 'production' }, { NODE_OPTIONS: '--trace-warnings' },
    { DATABASE_URL: 'postgresql://example.invalid/x' },
    { MIGRATION_DATABASE_URL: 'postgresql://example.invalid/x' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { PULSE_ENABLE_PUBLIC_INGRESS: 'YES' },
    { PULSE_ENABLE_TELEMETRY_SERVICE: 'YES' },
  ]) {
    const result = run(['--create'], extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSE_D15C5U2F2B/);
    assert.doesNotMatch(result.stdout, /OFFLINE CLUSTER STATE|CREATE PRIVATE RETAINED COPY/);
  }
});
test('5U-2F2B creation requires an independent exact approval', () => {
  for (const approval of ['', 'YES', 'ONE_STOPPED_LOCAL_COPY ', 'TEMPORARY_COPY_ONLY']) {
    const result = run(['--create'], { PULSE_APPROVE_5U2F2B_RETAINED_BACKUP: approval });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSE_D15C5U2F2B/);
    assert.doesNotMatch(result.stdout, /OFFLINE CLUSTER STATE|CREATE PRIVATE RETAINED COPY/);
  }
});
test('5U-2F2B pins exact old cluster and immutable target, not generic database URLs', () => {
  assert.match(source, /SOURCE_BASE="\$PARENT\/pulse-metrics-dev-5u2"/);
  assert.match(source, /BACKUP="\$PARENT\/pulse-metrics-dev-5u2-cold-backup-5u2f2b"/);
  assert.match(source, /OFFLINE_SHA='[a-f0-9]{64}'/);
  assert.match(source, /bash "\$OFFLINE"/);
  assert.match(source, /PostgreSQL major 16 required/);
  assert.doesNotMatch(source, /CREATE ROLE|\b(?:pg_dump|pg_restore|createdb|initdb|psql)\b|pg_ctl.*start/);
});
test('5U-2F2B requires stopped, unlinked, secure owner-only source', () => {
  assert.match(source, /postgres_unlinked_dir "\$SOURCE_DATA\/pg_tblspc"/);
  assert.match(source, /postgres_unlinked_dir "\$SOURCE_DATA\/pg_wal"/);
  assert.match(source, /postgres_absent "\$SOURCE_DATA\/postmaster.pid"/);
  assert.match(source, /\[\[ "\$cluster_state" == 'shut down' \]\]/);
  assert.match(source, /External tablespaces unsupported/);
  assert.match(source, /Unexpected source file or symlink/);
});
test('5U-2F2B never overwrites or removes existing backup and refuses insufficient space', () => {
  assert.match(source, /postgres_absent "\$BACKUP" \|\| refuse/);
  assert.match(source, /sudo -u postgres mkdir -m 0700 -- "\$BACKUP"/);
  assert.match(source, /source exceeds 1 GiB|Source exceeds 1 GiB/);
  assert.match(source, /local_size \* 2 \+ 268435456/);
  assert.doesNotMatch(source, /\brm\s+-rf\b|\bchmod\s+777\b|\btruncate\b/);
});
test('5U-2F2B hashes source and backup, retains manifest and refuses partial copies', () => {
  assert.match(source, /snapshot_digest\(\)/);
  assert.match(source, /sort -z/);
  assert.match(source, /cp -a --reflink=never/);
  assert.match(source, /"\$source_digest" == "\$backup_digest"/);
  assert.match(source, /"\$backup_size" == "\$source_file_bytes"/);
  assert.match(source, /regular_file_bytes\(\)/);
  assert.match(source, /local expected_metadata=\$'/);
  assert.match(source, /\.pulse-5u2f2b-incomplete/);
  assert.match(source, /\.pulse-5u2f2b-verified/);
  assert.match(source, /validate_backup/);
  assert.match(source, /NO RESTORE FROM THIS RETAINED COPY TESTED/);
});

test('5U-2F2B snapshot metadata regex accepts exact manifest, rejects extra fields', () => {
  const match = source.match(/local expected_metadata=(\$'[^']+')/);
  assert.ok(match, 'Expected shell manifest validation regex');
  const valid = 'pulse-metrics-5u2f2b-v1\\nfile_bytes=1024\\nfile_digest_sha256=' + 'a'.repeat(64);
  const shell = [
    `pattern=${match[1]}`,
    `valid=$'${valid}'`,
    '[[ "$valid" =~ $pattern ]] || exit 2',
    '[[ "${BASH_REMATCH[1]}" == 1024 ]] || exit 3',
    `invalid=$'${valid}\\nextra=unsafe'`,
    '[[ ! "$invalid" =~ $pattern ]] || exit 4',
  ].join('\n');
  const result = spawnSync('bash', ['-e', '-c', shell], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
