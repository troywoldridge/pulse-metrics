/** Synthetic fixture tests for D12 source guard. No project files modified. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyD12Foundation } from './verify-foundation.mjs';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./d11-source-lock.json', import.meta.url)), 'utf8'));
function blob(bytes) {return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');}
function fixture(operation) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-d12-audit-'));
  const pins = structuredClone(manifest);
  try {
    for (const path of Object.keys(pins.protectedGitBlobs)) {
      const destination = join(dir, path);
      mkdirSync(dirname(destination), { recursive: true });
      const source = path === 'package.json' ? JSON.stringify({scripts:{test:'node scripts/run-all-tests.mjs'}}) :
        path === 'server.ts' ? 'export const health = true;\n' :
        path === 'src/agent/run-linux-agent.ts' ? '// local telemetry only\n' :
        `// synthetic, intact reviewed source for ${path}\n`;
      writeFileSync(destination, source);
      pins.protectedGitBlobs[path] = blob(Buffer.from(source));
    }
    return operation(dir, pins);
  } finally {rmSync(dir, {recursive:true,force:true});}
}
test('D12 source guard accepts 11 synthetic pinned protected blobs', () => {
  fixture((dir,pins) => assert.deepEqual(verifyD12Foundation(dir,pins), {
    protectedSources: 11, publicEnrollment: 'UNMOUNTED', agentTransport: 'LOCAL_ONLY',
  }));
});
test('D12 source guard rejects modified D11 vault', () => {
  fixture((dir,pins) => {
    const p=join(dir,'src/agent/security/credential-vault.ts');
    writeFileSync(p,readFileSync(p,'utf8')+'\n// tampered\n');
    assert.throws(()=>verifyD12Foundation(dir,pins),/protected source drifted/);
  });
});
test('D12 source guard rejects mounted public enrollment', () => {
  fixture((dir,pins) => {
    const p=join(dir,'server.ts');
    writeFileSync(p,readFileSync(p,'utf8')+'\ncreateRedeemAgentEnrollmentRoute()\n');
    pins.protectedGitBlobs['server.ts']=blob(readFileSync(p));
    assert.throws(()=>verifyD12Foundation(dir,pins),/unexpectedly active/);
  });
});
test('D12 source guard rejects nonrecursive test command', () => {
  fixture((dir,pins) => {
    const p=join(dir,'package.json');
    writeFileSync(p,JSON.stringify({scripts:{test:'tsx --test src/**/*.test.ts'}}));
    pins.protectedGitBlobs['package.json']=blob(readFileSync(p));
    assert.throws(()=>verifyD12Foundation(dir,pins),/recursive test discovery/);
  });
});
test('D12 source guard refuses missing machine-identity contract', () => {
  fixture((dir,pins) => {
    unlinkSync(join(dir,'src/agent/security/machine-identity.ts'));
    assert.throws(()=>verifyD12Foundation(dir,pins),/protected source drifted/);
  });
});
test('D12 source guard rejects truncated lock manifest', () => {
  fixture((dir,pins) => {
    delete pins.protectedGitBlobs['src/agent/run-linux-agent.ts'];
    assert.throws(()=>verifyD12Foundation(dir,pins),/missing independent protected source pins/);
  });
});
