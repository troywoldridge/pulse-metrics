import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, SPECS, sha256, generateSql, buildCandidates, verifyOutputs,
} from './release-candidates.mjs';

const GUARD = `  IF current_database() <> 'pulse_metrics'
     OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('listen_addresses') <> ''
     OR current_setting('port') <> '55432'
     OR current_setting('data_directory') !~
       '^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'
     OR current_setting('unix_socket_directories') !~
       '^/tmp/pulse-replay-[A-Za-z0-9]{10}/socket$'
  THEN`;
const ORIGINAL = `-- disposable-only test fixture
-- second header line
\\set ON_ERROR_STOP on
BEGIN;
DO $preflight$
BEGIN
${GUARD}
    RAISE EXCEPTION 'disposable only';
  END IF;
END;
$preflight$;
-- A protected original SQL operation; MUST NOT be edited.
SELECT 42;
COMMIT;
`;
const SPEC = { label: 'fixture', source: 'source.sql', sha256: sha256(ORIGINAL) };

test('derived SQL preserves all operational SQL beyond first guard', () => {
  const output = generateSql(ORIGINAL, SPEC);
  const originalSuffix = ORIGINAL.slice(ORIGINAL.indexOf("    RAISE EXCEPTION 'disposable only';"));
  const newSuffix = output.slice(output.indexOf("    RAISE EXCEPTION 'disposable only';"));
  assert.equal(newSuffix, originalSuffix);
  assert.ok(output.includes("current_setting('port') = '55433'"));
  assert.ok(output.includes("/var/lib/postgresql/pulse-metrics-dev-5u2/data"));
  assert.ok(output.includes("current_setting('port') = '55432'"));
  assert.ok(output.includes("'^/tmp/pulse-replay-[A-Za-z0-9]{10}/data$'"));
  assert.ok(output.includes('NOT APPROVED FOR PRODUCTION'));
  assert.ok(!output.includes("current_setting('port') <> '55432'"));
});

test('source hash mismatch refuses modified migration body', () => {
  assert.throws(() => generateSql(ORIGINAL.replace('SELECT 42;', 'SELECT 43;'), SPEC), /pinned release input/);
});

test('noncanonical guard refuses derivation even with updated test hash', () => {
  const changed = ORIGINAL.replace("current_setting('port') <> '55432'", "current_setting('port') <> '5432'");
  assert.throws(() => generateSql(changed, { ...SPEC, sha256: sha256(changed) }), /guard structure/);
});

test('unexpected transaction ending refuses derivation', () => {
  const changed = ORIGINAL.replace('\nCOMMIT;\n', '\nSELECT 1;\n');
  assert.throws(() => generateSql(changed, { ...SPEC, sha256: sha256(changed) }), /transaction boundary/);
});

test('three source candidates are derived from actual locked files when present', t => {
  if (!SPECS.every(s => existsSync(join(ROOT, s.source)))) {
    t.skip('real repository source files are not available in this package preview');
    return;
  }
  const items = buildCandidates(ROOT);
  assert.equal(items.length, 3);
  for (const { spec, candidate, sourceHash, targetHash } of items) {
    assert.equal(sourceHash, spec.sha256);
    assert.equal(sha256(candidate), targetHash);
    assert.ok(candidate.includes(`-- Original source SHA-256: ${spec.sha256}`));
    assert.ok(candidate.endsWith('\nCOMMIT;\n'));
    assert.ok(!candidate.includes("current_setting('port') <> '55432'"));
    const source = readFileSync(join(ROOT, spec.source), 'utf8');
    assert.equal(sha256(source), spec.sha256);
  }
});

test('candidate verification detects missing or tampered output files', t => {
  if (!SPECS.every(s => existsSync(join(ROOT, s.target)))) {
    t.skip('generated candidate outputs are not present in this package preview');
    return;
  }
  assert.equal(verifyOutputs(ROOT).length, 3);
});
