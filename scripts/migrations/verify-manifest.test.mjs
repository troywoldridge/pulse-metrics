import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyManifest, REVIEWED } from './verify-manifest.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'pulse-manifest-test-'));
  try {
    mkdirSync(join(root, 'scripts/migrations'), { recursive: true });
    mkdirSync(join(root, 'scripts/admin'), { recursive: true });
    mkdirSync(join(root, 'drizzle/meta'), { recursive: true });
    const paths = [
      'scripts/migrations/privileged-manifest.json',
      'drizzle/0000_damp_tomorrow_man.sql', 'drizzle/meta/_journal.json',
      ...REVIEWED.map(([n, name]) => `scripts/admin/${n}_${name}.sql`),
    ];
    for (const path of paths) cpSync(path, join(root, path));
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reviewed manifest and all pinned SQL bytes verify', () => {
  fixture(root => assert.equal(verifyManifest(root).length, 6));
});
test('modified SQL is refused', () => {
  fixture(root => {
    writeFileSync(join(root, 'scripts/admin/005_workos_verified_email_sync.sql'), '-- tampered\n');
    assert.throws(() => verifyManifest(root), /source|changed/);
  });
});
test('changed Drizzle migration history is refused', () => {
  fixture(root => {
    writeFileSync(join(root, 'drizzle/meta/_journal.json'), '{}');
    assert.throws(() => verifyManifest(root), /Drizzle/);
  });
});
test('reordered or modified manifest is refused despite original sources', () => {
  fixture(root => {
    const file = join(root, 'scripts/migrations/privileged-manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    [manifest.steps[0], manifest.steps[1]] = [manifest.steps[1], manifest.steps[0]];
    writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => verifyManifest(root), /reordered/);
  });
});
test('unexpected seventh numbered administrator script is refused', () => {
  fixture(root => {
    writeFileSync(join(root, 'scripts/admin/007_unreviewed.sql'), 'SELECT 1;\n');
    assert.throws(() => verifyManifest(root), /untracked/);
  });
});
