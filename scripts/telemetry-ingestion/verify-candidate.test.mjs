import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  verifyCandidate,
  CANDIDATE,
} from './verify-candidate.mjs';

const ROOT = resolve(
  import.meta.dirname ?? process.cwd(),
  '../..'
);

const MANIFEST =
  'scripts/telemetry-ingestion/migrations/manifest.json';

function withFixture(operation) {
  const root = mkdtempSync(
    join(tmpdir(), 'pulse-d15b-source-test-')
  );

  try {
    const directory = join(
      root,
      'scripts/telemetry-ingestion/migrations'
    );

    mkdirSync(directory, { recursive: true });

    cpSync(
      resolve(ROOT, CANDIDATE),
      resolve(root, CANDIDATE)
    );

    cpSync(
      resolve(ROOT, MANIFEST),
      resolve(root, MANIFEST)
    );

    return operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reviewed D15B source is accepted', () => {
  withFixture(root => {
    assert.equal(verifyCandidate(root).version, '0001');
  });
});

test('changed SQL bytes are rejected', () => {
  withFixture(root => {
    const path = resolve(root, CANDIDATE);
    const original = readFileSync(path);

    writeFileSync(
      path,
      Buffer.concat([original, Buffer.from('\n-- changed\n')])
    );

    assert.throws(
      () => verifyCandidate(root),
      /fingerprint mismatch/
    );
  });
});

test('changed manifest hash is rejected', () => {
  withFixture(root => {
    const path = resolve(root, MANIFEST);
    const manifest = JSON.parse(
      readFileSync(path, 'utf8')
    );

    manifest.steps[0].sha256 = '0'.repeat(64);

    writeFileSync(
      path,
      JSON.stringify(manifest, null, 2)
    );

    assert.throws(
      () => verifyCandidate(root),
      /independent source lock/
    );
  });
});

test('unreviewed additional migration is rejected', () => {
  withFixture(root => {
    writeFileSync(
      resolve(
        root,
        'scripts/telemetry-ingestion/migrations/0002_unapproved.sql'
      ),
      'SELECT 1;\n'
    );

    assert.throws(
      () => verifyCandidate(root),
      /unexpected migration versions/
    );
  });
});
