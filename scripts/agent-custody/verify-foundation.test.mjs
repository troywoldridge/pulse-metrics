import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyD11Foundation } from './verify-foundation.mjs';

const lock = JSON.parse(readFileSync('scripts/agent-custody/d10-source-lock.json', 'utf8'));
function fixture(operation) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-d11-source-'));
  try {
    for (const name of [...Object.keys(lock.d10FileSha256),
      ...Object.keys(lock.protectedGitBlobs), 'package.json', 'scripts/run-all-tests.mjs']) {
      const dest = join(dir, name);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(name, dest);
    }
    operation(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('all 13 D10 file SHA256 pins and recursive test discovery pass', () => {
  fixture(dir => {
    const state = verifyD11Foundation(dir);
    assert.equal(state.d10PinnedFiles, 13);
    assert.equal(state.publicEnrollment, 'UNMOUNTED');
  });
});

test('tampered D10 migration source is rejected', () => {
  fixture(dir => {
    const name = Object.keys(lock.d10FileSha256).find(n => n.endsWith('.sql'));
    assert.ok(name);
    writeFileSync(join(dir, name), 'tampered');
    assert.throws(() => verifyD11Foundation(dir), /reviewed D10 source changed/);
  });
});

test('missing D10 source is rejected', () => {
  fixture(dir => {
    const name = Object.keys(lock.d10FileSha256)[0];
    unlinkSync(join(dir, name));
    assert.throws(() => verifyD11Foundation(dir), /reviewed D10 source changed/);
  });
});

test('old nonrecursive test command is refused', () => {
  fixture(dir => {
    const path = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg.scripts.test = 'tsx --test src/**/*.test.ts';
    writeFileSync(path, JSON.stringify(pkg));
    assert.throws(() => verifyD11Foundation(dir), /recursive TypeScript test discovery/);
  });
});

test('an accidentally mounted enrollment endpoint fails the source guard', () => {
  fixture(dir => {
    const file = join(dir, 'server.ts');
    writeFileSync(file, readFileSync(file, 'utf8') + '\ncreateRedeemAgentEnrollmentRoute();\n');
    assert.throws(() => verifyD11Foundation(dir), /public enrollment route/);
  });
});

test('agent runner cannot silently start using the credential vault', () => {
  fixture(dir => {
    const file = join(dir, 'src/agent/run-linux-agent.ts');
    writeFileSync(file, readFileSync(file, 'utf8') + '\nreadMachineCredential();\n');
    assert.throws(() => verifyD11Foundation(dir), /agent runner was unexpectedly changed/);
  });
});
