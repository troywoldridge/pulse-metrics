#!/usr/bin/env node
/**
 * Pulse Metrics D15C-5U-2C — Offline developer-migration source derivation.
 *
 * These are NEW candidate files for one exact persistent dev cluster and the
 * existing isolated replay cluster. Original disposable-only sources are not
 * touched. This is NOT a release installer and cannot access PostgreSQL.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DESTINATION = 'scripts/telemetry-persistent/migrations';
export const SPECS = Object.freeze([
  Object.freeze({
    label: 'network-quota',
    source: 'scripts/telemetry-quota/migrations/0001_telemetry_network_quota.sql',
    target: `${DESTINATION}/0001_network_quota_dev_candidate.sql`,
    sha256: '4cce6ab1a31d4f0f323e6c5ad380b46fc21f1611198b44cf914b74118e29afe8',
  }),
  Object.freeze({
    label: 'agent-quota',
    source: 'scripts/telemetry-agent-quota/migrations/0001_telemetry_agent_quota.sql',
    target: `${DESTINATION}/0002_agent_quota_dev_candidate.sql`,
    sha256: 'a90ec4b3c0b83c53b147d0160ab589cf673bfb032898b46075ce9c0b28f5f012',
  }),
  Object.freeze({
    label: 'credential-outcome',
    source: 'scripts/telemetry-auth-outcome/migrations/0002_machine_credential_rejection.sql',
    target: `${DESTINATION}/0003_credential_outcome_dev_candidate.sql`,
    sha256: '3061f797a7d1fa0dfb335130252c4d89a3d1ee50d263854a22caa2a6c4d8c771',
  }),
]);

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

const NEW_GUARD = `  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('listen_addresses') <> ''
     OR current_setting('server_version_num')::integer / 10000 <> 16
     OR NOT (
       (current_setting('port') = '55433'
        AND current_setting('data_directory') = '/var/lib/postgresql/pulse-metrics-dev-5u2/data'
        AND current_setting('unix_socket_directories') = '/var/lib/postgresql/pulse-metrics-dev-5u2/socket')
       OR
       (current_setting('port') = '55432'
        AND current_setting('data_directory') ~ '^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'
        AND current_setting('unix_socket_directories') ~ '^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$')
     )
  THEN`;

export function generateSql(sourceText, spec) {
  if (typeof sourceText !== 'string' || !spec || sha256(sourceText) !== spec.sha256) {
    throw new Error(`REFUSE_5U2C: original ${spec?.label ?? 'source'} differs from pinned release input`);
  }
  if (sourceText.includes('\r') || !sourceText.endsWith('\n') ||
      !sourceText.endsWith('\nCOMMIT;\n') ||
      sourceText.split('\nCOMMIT;\n').length !== 2) {
    throw new Error('REFUSE_5U2C: original SQL encoding or transaction boundary unexpected');
  }
  const psqlMarker = '\\set ON_ERROR_STOP on\n';
  const psqlAt = sourceText.indexOf(psqlMarker);
  if (psqlAt < 0 || sourceText.indexOf(psqlMarker, psqlAt + 1) !== -1) {
    throw new Error('REFUSE_5U2C: expected exactly one psql header');
  }
  const oldHeader = sourceText.slice(0, psqlAt);
  if (!/^(?:(?:--[^\n]*\n)|(?:\n))+$/.test(oldHeader)) {
    throw new Error('REFUSE_5U2C: unexpected original SQL header');
  }
  const startIndex = sourceText.indexOf("  IF current_database() <> 'pulse_metrics'\n", psqlAt);
  if (startIndex < 0) throw new Error('REFUSE_5U2C: original deployment guard missing');
  const endIndex = sourceText.indexOf('\n  THEN', startIndex);
  if (endIndex < 0 || endIndex - startIndex > 1200) {
    throw new Error('REFUSE_5U2C: original deployment guard boundary invalid');
  }
  const oldGuard = sourceText.slice(startIndex, endIndex + '\n  THEN'.length);
  const guardChecks = [
    "current_database() <> 'pulse_metrics'",
    "current_user <> 'postgres'",
    'inet_server_addr() IS NOT NULL',
    "current_setting('listen_addresses') <> ''",
    "current_setting('port') <> '55432'",
    "current_setting('data_directory') !~",
    "'^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'",
    "current_setting('unix_socket_directories') !~",
    "'^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$'",
  ];
  if (!guardChecks.every(part => oldGuard.includes(part)) ||
      oldGuard.includes('--') || oldGuard.includes(';') ||
      sourceText.slice(startIndex + 1).includes("  IF current_database() <> 'pulse_metrics'\n")) {
    throw new Error('REFUSE_5U2C: unexpected disposable-only guard structure');
  }
  const releaseHeader = [
    '-- Pulse Metrics D15C-5U-2C: NEW DEVELOPMENT RELEASE CANDIDATE.',
    '-- NOT APPROVED FOR PRODUCTION, STAGING, CUSTOMER DATA OR AUTOMATIC INSTALL.',
    `-- Original locked source: ${spec.source}`,
    `-- Original source SHA-256: ${spec.sha256}`,
    '-- Only the environment preflight and file header are changed.',
    '-- Contexts: exact dedicated persistent dev cluster OR pinned disposable replay.',
    '-- Administrator must separately verify cluster identity and migration receipts.',
    '-- This SQL preserves the source function bodies, quota semantics and ACLs.',
    '',
  ].join('\n');
  return releaseHeader + sourceText.slice(psqlAt, startIndex) + NEW_GUARD +
    sourceText.slice(endIndex + '\n  THEN'.length);
}

function assertFile(path) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) {
    throw new Error('REFUSE_5U2C: unexpected source file type');
  }
}

export function buildCandidates(root = ROOT) {
  return SPECS.map(spec => {
    const sourcePath = join(root, spec.source);
    assertFile(sourcePath);
    const original = readFileSync(sourcePath, 'utf8');
    const candidate = generateSql(original, spec);
    return { spec, candidate, sourceHash: sha256(original), targetHash: sha256(candidate) };
  });
}

export function manifestFor(items) {
  return JSON.stringify({
    releaseCandidate: 'D15C-5U-2C',
    authorization: 'NOT_APPROVED_FOR_INSTALLATION',
    databaseTarget: 'dedicated-development-only',
    migrations: items.map(({ spec, sourceHash, targetHash }) => ({
      label: spec.label,
      source: spec.source,
      sourceSha256: sourceHash,
      candidate: spec.target,
      candidateSha256: targetHash,
    })),
  }, null, 2) + '\n';
}

export function verifyOutputs(root = ROOT, items = buildCandidates(root)) {
  for (const { spec, candidate } of items) {
    const filename = join(root, spec.target);
    assertFile(filename);
    if (readFileSync(filename, 'utf8') !== candidate) {
      throw new Error(`REFUSE_5U2C: generated ${spec.label} differs from independently regenerated SQL`);
    }
  }
  const manifest = join(root, DESTINATION, 'candidate-manifest.json');
  assertFile(manifest);
  if (readFileSync(manifest, 'utf8') !== manifestFor(items)) {
    throw new Error('REFUSE_5U2C: candidate manifest drift');
  }
  return items;
}

function main() {
  if (process.argv.length !== 3 || !['--plan', '--write', '--verify'].includes(process.argv[2])) {
    throw new Error('Usage: node scripts/telemetry-persistent/release-candidates.mjs --plan|--write|--verify');
  }
  if (process.env.NODE_ENV === 'production' || process.env.NODE_OPTIONS ||
      process.env.PULSE_ALLOW_PRODUCTION_MIGRATION) {
    throw new Error('REFUSE_5U2C: production or inherited Node options refused');
  }
  const mode = process.argv[2];
  const items = buildCandidates();
  if (mode === '--plan') {
    console.log('D15C-5U-2C SOURCE-DERIVATION PLAN (NO DATABASE ACCESS)');
    for (const { spec, sourceHash, targetHash } of items) {
      console.log(`${spec.label} | old ${sourceHash} | candidate ${targetHash} | ${spec.target}`);
    }
    console.log('No files, database objects or services changed. Candidate is NOT approved for installation.');
    return;
  }
  if (mode === '--verify') {
    verifyOutputs(ROOT, items);
    console.log('PASS: all three NEW development SQL files and manifest match pinned originals and exact derivation');
    console.log('NO DATABASE CONNECTION | NO DEPLOYMENT APPROVAL');
    return;
  }
  if (process.env.PULSE_APPROVE_5U2C_GENERATION !== 'OFFLINE_FILES_ONLY') {
    throw new Error('REFUSE_5U2C: explicit offline candidate generation approval required');
  }
  const outDir = join(ROOT, DESTINATION);
  for (const { spec } of items) {
    if (existsSync(join(ROOT, spec.target))) {
      throw new Error(`REFUSE_5U2C: candidate path already exists (${spec.label})`);
    }
  }
  if (existsSync(join(outDir, 'candidate-manifest.json'))) {
    throw new Error('REFUSE_5U2C: manifest already exists');
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const payloads = [
    ...items.map(({ spec, candidate }) => [join(ROOT, spec.target), candidate]),
    [join(outDir, 'candidate-manifest.json'), manifestFor(items)],
  ];
  // Exclusive create. Never overwrite an existing candidate or review artifact.
  for (const [path, contents] of payloads) {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, contents, 'utf8'); }
    finally { closeSync(fd); }
  }
  verifyOutputs(ROOT, items);
  console.log('PASS: three complete NEW candidate SQL files and immutable-source manifest generated');
  console.log('SOURCE MIGRATIONS UNCHANGED | NO POSTGRESQL ACCESS | NOT RELEASED');
  for (const { spec, targetHash } of items) console.log(`${spec.target} SHA256=${targetHash}`);
}

const launched = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launched) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'REFUSE_5U2C: generator failed');
    process.exitCode = 1;
  }
}
