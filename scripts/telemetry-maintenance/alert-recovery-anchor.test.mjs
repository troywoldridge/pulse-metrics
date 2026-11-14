/** D15C-5G: isolated file-backed security unit tests; no network or database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants, chmodSync, closeSync, existsSync, lstatSync, mkdirSync,
  openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendAuditRecord } from './maintenance-audit-policy.mjs';
import { HANDOFF, queueAuditReceipt, beginLocalAttempt,
  finishLocalAttempt } from './isolated-alert-handoff.mjs';
import { RECOVERY, freezeLocalWitness, readFrozenWitness,
  inspectFrozenRecovery, guardRecoveryRehearsal,
  assertPrivateWitnessDirectory } from './alert-recovery-anchor.mjs';

const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function makeDir(prefix, marker) {
  const dir = `/tmp/${prefix}-${randomBytes(5).toString('hex')}`;
  mkdirSync(dir, {mode:0o700});
  closeSync(openSync(`${dir}/${marker}`,constants.O_CREAT|constants.O_EXCL|
    constants.O_WRONLY|constants.O_NOFOLLOW,0o600));
  return dir;
}
function fixture() {
  const dirs = [];
  const mk = (a,b) => { const d=makeDir(a,b); dirs.push(d); return d; };
  const audit = mk('pulse-maint-audit','.pulse-maintenance-audit-marker');
  const outbox = mk('pulse-alert-handoff',HANDOFF.marker);
  const witness = mk('pulse-alert-witness',RECOVERY.marker);
  const close = () => {
    for (const d of dirs.reverse()) {
      // Only fixture-generated exact /tmp paths. Never remove a user path.
      assert.match(d,/^\/tmp\/pulse-(?:maint-audit|alert-handoff|alert-witness)-[a-f0-9]{10}$/);
      rmSync(d,{force:true,recursive:true});
    }
  };
  const add = (kind='critical') => {
    const fields = kind === 'none' ?
      {status:'completed',alertCode:null,severity:'none',batches:1,
        networkRemoved:0,agentRemoved:0} :
      kind === 'warning' ?
      {status:'completed',alertCode:'maintenance_possible_backlog',
        severity:'warning',batches:3,networkRemoved:750,agentRemoved:750} :
      {status:'failed',alertCode:'maintenance_operation_failed',
        severity:'critical',batches:0,networkRemoved:0,agentRemoved:0};
    return appendAuditRecord(audit,fields);
  };
  return {audit,outbox,witness,add,close};
}
async function inside(fn) {
  const f=fixture();
  try { return await fn(f); } finally { f.close(); }
}

test('D15C-5G independent-looking local witness is explicitly NOT externally anchored',()=>{
  assert.equal(RECOVERY.liveDelivery,false);
  assert.equal(RECOVERY.automaticReplay,false);
  assert.equal(RECOVERY.humanAcknowledgementVerified,false);
  assert.equal(RECOVERY.independentExternalCustody,false);
  assert.equal(RECOVERY.productionAuthorized,false);
  assert.equal(RECOVERY.publicLaunch,'NO_GO');
});
test('D15C-5G snapshot is private and refuses re-anchoring',()=>inside(f=>{
  const a=f.add(); queueAuditReceipt(f.outbox,a);
  assert.deepEqual(freezeLocalWitness(f.audit,f.outbox,f.witness),{
    frozen:true,reviewOnly:true,externallyAnchored:false});
  const a1=readFrozenWitness(f.witness);
  assert.equal(a1.auditSequence,1);
  assert.equal(a1.outboxCount,1);
  assert.equal(a1.missingOutbox,0);
  assert.equal(lstatSync(`${f.witness}/${RECOVERY.file}`).mode&0o777,0o600);
  assert.throws(()=>freezeLocalWitness(f.audit,f.outbox,f.witness));
}));
test('D15C-5G status plan refuses automatic replay and verified acknowledgement',()=>inside(f=>{
  f.add('none');
  const pending=f.add('warning'); const inFlight=f.add();
  const retry=f.add(); const accepted=f.add(); const duplicate=f.add();
  const dead=f.add(); f.add(); // missing outbox entry is a review requirement
  const p=queueAuditReceipt(f.outbox,pending);
  const i=queueAuditReceipt(f.outbox,inFlight);
  const r=queueAuditReceipt(f.outbox,retry);
  const a=queueAuditReceipt(f.outbox,accepted);
  const d=queueAuditReceipt(f.outbox,duplicate);
  const x=queueAuditReceipt(f.outbox,dead);
  beginLocalAttempt(f.outbox,i.key);
  finishLocalAttempt(f.outbox,r.key,beginLocalAttempt(f.outbox,r.key).attempts,'retryable');
  finishLocalAttempt(f.outbox,a.key,beginLocalAttempt(f.outbox,a.key).attempts,'transport_accepted');
  finishLocalAttempt(f.outbox,d.key,beginLocalAttempt(f.outbox,d.key).attempts,'receiver_duplicate');
  finishLocalAttempt(f.outbox,x.key,beginLocalAttempt(f.outbox,x.key).attempts,'permanent_failure');
  freezeLocalWitness(f.audit,f.outbox,f.witness);
  const plan=inspectFrozenRecovery(f.audit,f.outbox,f.witness);
  assert.equal(plan.decision,'manual_review_required');
  assert.equal(plan.automaticReplayAuthorized,false);
  assert.equal(plan.humanAcknowledgementVerified,false);
  assert.equal(plan.independentExternalCustodyVerified,false);
  assert.deepEqual(plan.counts,{
    pending:1,inFlight:1,retryPending:1,transportAccepted:1,
    receiverDuplicate:1,deadLetter:1,missingOutbox:1});
  assert.throws(()=>beginLocalAttempt(f.outbox,i.key));
  assert.equal(p.status,'pending');
}));
test('D15C-5G rejects changed outbox even when it remains syntactically valid',()=>inside(f=>{
  const r=f.add(); const q=queueAuditReceipt(f.outbox,r);
  freezeLocalWitness(f.audit,f.outbox,f.witness);
  beginLocalAttempt(f.outbox,q.key);
  assert.throws(()=>inspectFrozenRecovery(f.audit,f.outbox,f.witness));
}));
test('D15C-5G validates source journal against full expected alert/queue bindings',()=>inside(f=>{
  const r=f.add(); queueAuditReceipt(f.outbox,r);
  const path=`${f.outbox}/${HANDOFF.file}`;
  const source=JSON.parse(readFileSync(path,'utf8'));
  source.records[0].key='f'.repeat(64);
  writeFileSync(path,JSON.stringify(source));
  assert.throws(()=>freezeLocalWitness(f.audit,f.outbox,f.witness));
}));
test('D15C-5G detects a locally recomputed valid-looking audit chain',()=>inside(f=>{
  const r1=f.add('warning'); const r2=f.add();
  queueAuditReceipt(f.outbox,r1);queueAuditReceipt(f.outbox,r2);
  freezeLocalWitness(f.audit,f.outbox,f.witness);
  const path=`${f.audit}/maintenance-audit.jsonl`;
  const rows=readFileSync(path,'utf8').trim().split('\n').map(JSON.parse);
  rows[0].timestamp='2026-01-01T00:00:00.000Z';
  const {hash:old1,...body1}=rows[0]; rows[0].hash=sha(body1);
  rows[1].previousHash=rows[0].hash;
  const {hash:old2,...body2}=rows[1]; rows[1].hash=sha(body2);
  assert.notEqual(rows[1].hash,r2.hash);
  writeFileSync(path,rows.map(JSON.stringify).join('\n')+'\n');
  assert.throws(()=>inspectFrozenRecovery(f.audit,f.outbox,f.witness));
}));
test('D15C-5G rejects a truncated but internally valid earlier journal',()=>inside(f=>{
  f.add();f.add(); freezeLocalWitness(f.audit,f.outbox,f.witness);
  const path=`${f.audit}/maintenance-audit.jsonl`;
  const first=readFileSync(path,'utf8').split('\n')[0];
  writeFileSync(path,`${first}\n`);
  assert.throws(()=>inspectFrozenRecovery(f.audit,f.outbox,f.witness));
}));
test('D15C-5G refuses private witness with loose permissions',()=>inside(f=>{
  f.add(); freezeLocalWitness(f.audit,f.outbox,f.witness);
  chmodSync(`${f.witness}/${RECOVERY.file}`,0o644);
  assert.throws(()=>readFrozenWitness(f.witness));
}));
test('D15C-5G rejects symlinked and dangling frozen witness',()=>inside(f=>{
  f.add(); freezeLocalWitness(f.audit,f.outbox,f.witness);
  unlinkSync(`${f.witness}/${RECOVERY.file}`);
  symlinkSync('/tmp/definitely-not-a-valid-witness',`${f.witness}/${RECOVERY.file}`);
  assert.throws(()=>readFrozenWitness(f.witness));
  assert.throws(()=>freezeLocalWitness(f.audit,f.outbox,f.witness));
}));
test('D15C-5G rejects unsafe witness directory and marker',()=>inside(f=>{
  chmodSync(f.witness,0o777);
  assert.throws(()=>assertPrivateWitnessDirectory(f.witness));
  chmodSync(f.witness,0o700);
  chmodSync(`${f.witness}/${RECOVERY.marker}`,0o644);
  assert.throws(()=>assertPrivateWitnessDirectory(f.witness));
}));
test('D15C-5G rejects tampered anchor hash and unexpected receipt fields',()=>inside(f=>{
  const r=f.add(); queueAuditReceipt(f.outbox,r);
  freezeLocalWitness(f.audit,f.outbox,f.witness);
  const path=`${f.witness}/${RECOVERY.file}`;
  const body=JSON.parse(readFileSync(path,'utf8'));
  body.auditHead='0'.repeat(64);
  writeFileSync(path,JSON.stringify(body));
  assert.throws(()=>readFrozenWitness(f.witness));
}));
test('D15C-5G rejects forged human acknowledgement in local outbox',()=>inside(f=>{
  const r=f.add();queueAuditReceipt(f.outbox,r);
  const path=`${f.outbox}/${HANDOFF.file}`;
  const data=JSON.parse(readFileSync(path,'utf8'));
  data.records[0].humanAcknowledged=true;
  writeFileSync(path,JSON.stringify(data));
  assert.throws(()=>freezeLocalWitness(f.audit,f.outbox,f.witness));
}));
test('D15C-5G missing eligible alert is a review count, not an auto-send',()=>inside(f=>{
  f.add('none'); f.add('warning');
  freezeLocalWitness(f.audit,f.outbox,f.witness);
  assert.equal(inspectFrozenRecovery(f.audit,f.outbox,f.witness).counts.missingOutbox,1);
}));
test('D15C-5G unexpected witness fields refuse',()=>inside(f=>{
  f.add(); freezeLocalWitness(f.audit,f.outbox,f.witness);
  const path=`${f.witness}/${RECOVERY.file}`;
  const a=JSON.parse(readFileSync(path,'utf8'));
  a.actor='pretend-approved';
  writeFileSync(path,JSON.stringify(a));
  assert.throws(()=>readFrozenWitness(f.witness));
}));
test('D15C-5G duplicate-key JSON witness is refused even with a valid parsed hash',()=>inside(f=>{
  f.add();freezeLocalWitness(f.audit,f.outbox,f.witness);
  const path=`${f.witness}/${RECOVERY.file}`;
  const original=readFileSync(path,'utf8');
  // Parser would otherwise keep the last schema while accepting both fields.
  const withDuplicate=original.replace('"schema":"pulse-local-alert-witness/v1",',
    '"schema":"pulse-local-alert-witness/v1","schema":"pulse-local-alert-witness/v1",');
  assert.notEqual(withDuplicate,original);
  writeFileSync(path,withDuplicate);
  assert.throws(()=>readFrozenWitness(f.witness));
}));
test('D15C-5G guards refuse production, credentials, external routes and argv',()=>{
  const good={PULSE_D15C5G_DISPOSABLE_ONLY:'YES'};
  assert.equal(guardRecoveryRehearsal(good,2),true);
  for (const extra of [
    {PULSE_D15C5G_DISPOSABLE_ONLY:''},{NODE_ENV:'production'},
    {DATABASE_URL:'postgres://example.invalid'}, {PGPASSWORD:'secret'},
    {PGHOST:'localhost'},{PULSE_D15C5G_DELIVERY_URL:'https://example.invalid'},
    {PULSE_D15C5G_ANCHOR_URL:'https://example.invalid'},
    {PULSE_D15C5G_APPROVE_LIVE:'yes'},
    {PULSE_D15C5G_OPERATOR:'operator'},
  ]) assert.equal(guardRecoveryRehearsal({...good,...extra},2),false);
  assert.equal(guardRecoveryRehearsal(good,3),false);
});
