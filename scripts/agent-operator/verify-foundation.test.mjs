import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyD14Foundation } from './verify-foundation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root,'scripts/agent-operator/d13-source-lock.json'),'utf8'));
function blob(data) {const b=Buffer.from(data);return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');}
function fixture() {
  const temp=mkdtempSync(join(tmpdir(),'pulse-d14-lock-'));
  const pins=structuredClone(lock);
  for (const path of Object.keys(pins.protectedGitBlobs)) {
    const target=join(temp,path);
    mkdirSync(dirname(target),{recursive:true});
    const content=path==='scripts/agent-identity/migrations/0003_preallocated_identity.sql' ?
      readFileSync(join(root,path)) :
      path==='package.json' ? '{"scripts":{"test":"node scripts/run-all-tests.mjs"}}' :
      `SAFE TEST SOURCE ${path}\n`;
    writeFileSync(target,content);
    pins.protectedGitBlobs[path]=blob(content);
  }
  for (const path of ['src/agent/enrollment/operator-cli.ts','src/agent/enrollment/operator-token-input.ts']) {
    const target=join(temp,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,'export const safe = true;\n');
  }
  return {temp,pins,cleanup:()=>rmSync(temp,{recursive:true,force:true})};
}

test('D14 immutable D13 SQL and 17 synthetic source pins verify',()=>{
  const f=fixture();try {assert.equal(verifyD14Foundation(f.temp,f.pins).historicalFiles,17);}finally {f.cleanup();}
});
test('D14 refuses tampered committed D13 migration',()=>{
  const f=fixture();try {
    const path=join(f.temp,'scripts/agent-identity/migrations/0003_preallocated_identity.sql');
    writeFileSync(path,'ALTER TABLE fake;');
    assert.throws(()=>verifyD14Foundation(f.temp,f.pins),/REFUSE_D14_FOUNDATION/);
  }finally{f.cleanup();}
});
test('D14 refuses changed historical vault even when unmounted',()=>{
  const f=fixture();try {
    writeFileSync(join(f.temp,'src/agent/security/credential-vault.ts'),'tamper');
    assert.throws(()=>verifyD14Foundation(f.temp,f.pins),/historical source changed/);
  }finally{f.cleanup();}
});
test('D14 rejects removal of test discovery',()=>{
  const f=fixture();try {
    const content='{"scripts":{"test":"tsx --test src/**/*.test.ts"}}';
    writeFileSync(join(f.temp,'package.json'),content);
    f.pins.protectedGitBlobs['package.json']=blob(content);
    assert.throws(()=>verifyD14Foundation(f.temp,f.pins),/test discovery/);
  }finally{f.cleanup();}
});
test('D14 refuses accidental production route mount even when source pin updated',()=>{
  const f=fixture();try {
    const content='createIssuePreallocatedEnrollmentRoute();';
    writeFileSync(join(f.temp,'server.ts'),content);
    f.pins.protectedGitBlobs['server.ts']=blob(content);
    assert.throws(()=>verifyD14Foundation(f.temp,f.pins),/public enrollment route mounted/);
  }finally{f.cleanup();}
});
test('D14 refuses wiring CLI into always-on Linux telemetry runner',()=>{
  const f=fixture();try {
    const content='enrollWithOperatorToken();';
    writeFileSync(join(f.temp,'src/agent/run-linux-agent.ts'),content);
    f.pins.protectedGitBlobs['src/agent/run-linux-agent.ts']=blob(content);
    assert.throws(()=>verifyD14Foundation(f.temp,f.pins),/telemetry runner/);
  }finally{f.cleanup();}
});
test('D14 refuses symlinked committed security source',()=>{
  const f=fixture();try {
    const path=join(f.temp,'src/agent/security/credential-vault.ts');
    rmSync(path);
    symlinkSync(join(f.temp,'package.json'),path);
    assert.throws(()=>verifyD14Foundation(f.temp,f.pins),/protected file unsafe/);
  }finally{f.cleanup();}
});
test('D14 refuses command-line code that reads secrets from process environment',()=>{
  const f=fixture();try {
    writeFileSync(join(f.temp,'src/agent/enrollment/operator-cli.ts'),'const token = process.env.TOKEN;');
    assert.throws(()=>verifyD14Foundation(f.temp,f.pins),/environment secret/);
  }finally{f.cleanup();}
});
test('D14 refuses incomplete or fabricated source lock',()=>{
  const f=fixture();try {
    delete f.pins.protectedGitBlobs['server.ts'];
    assert.throws(()=>verifyD14Foundation(f.temp,f.pins),/incomplete/);
  }finally{f.cleanup();}
});
