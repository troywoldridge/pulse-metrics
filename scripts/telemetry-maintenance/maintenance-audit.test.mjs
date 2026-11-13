import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, symlinkSync,
         rmSync, statSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyController, verifyAuditJournal, appendAuditRecord,
         assertPrivateAuditDirectory, acquireAuditJournalLock } from './maintenance-audit-policy.mjs';

function transcript(...events) {
  return events.map(e => `D15C5C_EVENT ${JSON.stringify(e)}`).join('\n') + '\n';
}
const started = {event:'maintenance_started', alert:false};
const batch = (i,n,a) => ({event:'batch_completed', batch:i,networkRemoved:n,agentRemoved:a,alert:false});
const completed = (n,a,b,backlog) => ({event:'maintenance_completed', batches:b,
  networkRemoved:n,agentRemoved:a,possibleBacklog:backlog,alert:backlog});
const failure = {event:'maintenance_failed', reason:'operation_unavailable',alert:true};
const run = (exitCode, stdout, stderr = '') => classifyController({exitCode,stdout,stderr});
function withDir(fn) {
  const dir = join(tmpdir(), `pulse-maint-audit-${randomBytes(5).toString('hex')}`);
  mkdirSync(dir, {mode:0o700});
  try {
    chmodSync(dir, 0o700);
    writeFileSync(`${dir}/.pulse-maintenance-audit-marker`, 'TEST ONLY\n', {mode:0o600});
    return fn(dir);
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('D15C-5D accept bounded completed maintenance with no alert', () => {
  const result = run(0, transcript(started,batch(1,20,18),batch(2,0,0),completed(20,18,2,false)));
  assert.deepEqual(result, {status:'completed',alertCode:null,severity:'none',batches:2,
    networkRemoved:20,agentRemoved:18});
});

test('D15C-5D identify 3-batch possible backlog as warning', () => {
  const result = run(0, transcript(started,batch(1,250,250),batch(2,250,250),
    batch(3,250,250),completed(750,750,3,true)));
  assert.deepEqual(result,{status:'completed',alertCode:'maintenance_possible_backlog',
    severity:'warning',batches:3,networkRemoved:750,agentRemoved:750});
});

test('D15C-5D recognize overlap without alert or cleanup', () => {
  assert.deepEqual(run(0,transcript({event:'overlap_skipped',alert:false})),
    {status:'overlap_skipped',alertCode:null,severity:'none',batches:0,
     networkRemoved:0,agentRemoved:0});
});

test('D15C-5D failure after start becomes critical alert candidate', () => {
  assert.deepEqual(run(1,transcript(started,failure)),
    {status:'failed',alertCode:'maintenance_operation_failed',severity:'critical',
      batches:0,networkRemoved:0,agentRemoved:0});
});

test('D15C-5D invalid output is not reused or leaked', () => {
  for (const bad of [
    'FATAL: password=not-safe\n',
    transcript(started,{event:'batch_completed',batch:1,networkRemoved:251,agentRemoved:0,alert:false},completed(251,0,1,false)),
    transcript(started,batch(1,1,1),completed(2,1,1,false)),
    transcript(started,batch(1,0,0),completed(0,0,1,true)),
    transcript(started,batch(1,1,1),batch(2,0,0),batch(3,2,3),completed(3,4,3,true)),
    transcript(started,failure),
    transcript({event:'maintenance_started', alert:false, sql:'SELECT secret'}),
    transcript({event:'overlap_skipped',alert:true}),
  ]) {
    const classified = run(0,bad);
    assert.equal(classified.status, 'invalid_output');
    assert.equal(classified.alertCode,'maintenance_protocol_invalid');
    assert.equal(JSON.stringify(classified).includes('password'),false);
  }
});

test('D15C-5D nonempty stderr, abnormal status, truncated stdout fail closed', () => {
  for (const options of [
    {exitCode:0,stdout:transcript(started,batch(1,0,0),completed(0,0,1,false)),stderr:'driver stack'},
    {exitCode:null,signal:'SIGTERM',stdout:''},
    {exitCode:0,stdout:transcript({event:'overlap_skipped',alert:false}).slice(0,-1)},
  ]) assert.equal(classifyController(options).status,'invalid_output');
});

test('D15C-5D audit journal is mode 0600 and linked by SHA-256', () => withDir(dir => {
  const first = appendAuditRecord(dir,run(0,transcript({event:'overlap_skipped',alert:false})));
  const second = appendAuditRecord(dir,run(1,transcript(failure)));
  const status = verifyAuditJournal(dir);
  assert.equal(status.sequence,2);
  assert.equal(first.previousHash,'0'.repeat(64));
  assert.equal(second.previousHash,first.hash);
  assert.equal(status.hash,second.hash);
  assert.equal(statSync(`${dir}/maintenance-audit.jsonl`).mode & 0o777,0o600);
  assert.ok(!readFileSync(`${dir}/maintenance-audit.jsonl`,'utf8').includes('postgres://'));
}));

test('D15C-5D tampered prior rows and incomplete tails block append', () => withDir(dir => {
  appendAuditRecord(dir,run(0,transcript({event:'overlap_skipped',alert:false})));
  const file = `${dir}/maintenance-audit.jsonl`;
  const pristine = readFileSync(file,'utf8');
  writeFileSync(file, pristine.replace('overlap_skipped','maintenance_failed'));
  assert.throws(() => verifyAuditJournal(dir),/audit_integrity_failed/);
  assert.throws(() => appendAuditRecord(dir,run(1,transcript(failure))),/audit_integrity_failed/);
  writeFileSync(file,pristine);
  appendFileSync(file,'partial');
  assert.throws(() => verifyAuditJournal(dir),/audit_integrity_failed/);
}));

test('D15C-5D symlinked journal and writable directory rejected', () => withDir(dir => {
  const outside = join(dir,'outside');
  writeFileSync(outside,'untrusted',{mode:0o600});
  symlinkSync(outside,`${dir}/maintenance-audit.jsonl`);
  assert.throws(() => verifyAuditJournal(dir),/audit_path_rejected/);
  chmodSync(dir,0o777);
  assert.throws(() => assertPrivateAuditDirectory(dir),/audit_directory_rejected/);
}));

test('D15C-5D malformed journal classification cannot persist', () => withDir(dir => {
  assert.throws(() => appendAuditRecord(dir,{status:'completed', secret:'x'}),
    /audit_invalid_classification/);
  assert.equal(verifyAuditJournal(dir).sequence,0);
}));

test('D15C-5D exclusive audit lock rejects overlap and stale locks', () => withDir(dir => {
  const release = acquireAuditJournalLock(dir);
  assert.throws(() => acquireAuditJournalLock(dir), /audit_run_already_locked/);
  release();
  assert.throws(() => release(), /audit_unlock_failed/);
  const next = acquireAuditJournalLock(dir);
  next();
}));
