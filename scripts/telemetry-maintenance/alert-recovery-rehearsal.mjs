#!/usr/bin/env node
/**
 * Pulse Metrics D15C-5G — disposable, OFFLINE recovery rehearsal.
 * Synthetic local 5D journal + 5F outbox + separate frozen local witness.
 * No HTTP call, PostgreSQL, identity provisioning, credential, scheduling,
 * live acknowledgement, external anchor or production operator.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, closeSync, mkdirSync, openSync, readFileSync,
  rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendAuditRecord, acquireAuditJournalLock, verifyAuditJournal }
  from './maintenance-audit-policy.mjs';
import { HANDOFF, queueAuditReceipt, acquireHandoffLock,
  readPrivateOutbox, beginLocalAttempt, finishLocalAttempt }
  from './isolated-alert-handoff.mjs';
import { RECOVERY, freezeLocalWitness, inspectFrozenRecovery,
  guardRecoveryRehearsal } from './alert-recovery-anchor.mjs';

if (!guardRecoveryRehearsal()) {
  process.stdout.write('D15C5G_TEST {"event":"configuration_denied","live":false}\n');
  process.exit(1);
}

let stage = 'create';
const dirs = [];
let releaseAudit, releaseOutbox;
let status = 0;
function privateDir(prefix, marker) {
  const d = `/tmp/${prefix}-${randomBytes(5).toString('hex')}`;
  mkdirSync(d,{mode:0o700}); dirs.push(d);
  closeSync(openSync(`${d}/${marker}`,constants.O_CREAT|constants.O_EXCL|
    constants.O_WRONLY|constants.O_NOFOLLOW,0o600));
  return d;
}
function assertRefused(callback) { assert.throws(callback); }
function receipt(audit,kind) {
  const body = kind === 'none' ?
    {status:'completed',alertCode:null,severity:'none',
      batches:1,networkRemoved:0,agentRemoved:0} :
    kind === 'warning' ?
    {status:'completed',alertCode:'maintenance_possible_backlog',
      severity:'warning',batches:3,networkRemoved:750,agentRemoved:750} :
    {status:'failed',alertCode:'maintenance_operation_failed',
      severity:'critical',batches:0,networkRemoved:0,agentRemoved:0};
  return appendAuditRecord(audit,body);
}
function processBoundaryCheck(audit,outbox,witness,inflightKey,expected) {
  // This child has fresh in-memory state. It has no send loop, endpoint,
  // network destination, or access to a production identity.
  const recovery = new URL('./alert-recovery-anchor.mjs',import.meta.url).href;
  const handoff = new URL('./isolated-alert-handoff.mjs',import.meta.url).href;
  const program = `
    import { inspectFrozenRecovery } from ${JSON.stringify(recovery)};
    import { beginLocalAttempt } from ${JSON.stringify(handoff)};
    const dir=process.env.PULSE_D15C5G_TEST_OUTBOX;
    const plan=inspectFrozenRecovery(
      process.env.PULSE_D15C5G_TEST_AUDIT,dir,
      process.env.PULSE_D15C5G_TEST_WITNESS);
    if(plan.decision!=='manual_review_required'||
        plan.automaticReplayAuthorized!==false||
        plan.humanAcknowledgementVerified!==false||
        plan.counts.inFlight!==1)process.exit(2);
    try {beginLocalAttempt(dir,process.env.PULSE_D15C5G_TEST_KEY);process.exit(3)}
    catch { process.stdout.write('D15C5G_CHILD recovery_inspected\\n'); }
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program],{
    env:{...process.env,PULSE_D15C5G_TEST_AUDIT:audit,
      PULSE_D15C5G_TEST_OUTBOX:outbox,PULSE_D15C5G_TEST_WITNESS:witness,
      PULSE_D15C5G_TEST_KEY:inflightKey},
    encoding:'utf8',timeout:7000,maxBuffer:4096,
  });
  assert.equal(child.signal,null);
  assert.equal(child.status,0);
  assert.equal(child.stdout,'D15C5G_CHILD recovery_inspected\n');
  assert.equal(child.stderr,'');
  assert.equal(expected.inFlight,1);
}
async function main() {
  stage='initialize private review artifacts';
  const audit = privateDir('pulse-maint-audit','.pulse-maintenance-audit-marker');
  const outbox = privateDir('pulse-alert-handoff',HANDOFF.marker);
  const witness = privateDir('pulse-alert-witness',RECOVERY.marker);
  releaseAudit=acquireAuditJournalLock(audit);
  releaseOutbox=acquireHandoffLock(outbox);

  stage='seed synthetic audit and outbox states';
  const none=receipt(audit,'none');
  const pending=receipt(audit,'warning');
  const interrupted=receipt(audit,'warning');
  const retry=receipt(audit,'critical');
  const accepted=receipt(audit,'critical');
  const duplicate=receipt(audit,'critical');
  const dead=receipt(audit,'critical');
  const missing=receipt(audit,'warning');
  assert.equal(verifyAuditJournal(audit).sequence,8);
  assertRefused(()=>queueAuditReceipt(outbox,none));
  const p=queueAuditReceipt(outbox,pending);
  const i=queueAuditReceipt(outbox,interrupted);
  const r=queueAuditReceipt(outbox,retry);
  const a=queueAuditReceipt(outbox,accepted);
  const d=queueAuditReceipt(outbox,duplicate);
  const x=queueAuditReceipt(outbox,dead);
  assert.equal(readPrivateOutbox(outbox).records.length,6);
  assert.ok(missing && p);
  // Persist an attempt before an imagined process crash; no actual send.
  assert.equal(beginLocalAttempt(outbox,i.key).status,'in_flight');
  finishLocalAttempt(outbox,r.key,beginLocalAttempt(outbox,r.key).attempts,'retryable');
  finishLocalAttempt(outbox,a.key,beginLocalAttempt(outbox,a.key).attempts,'transport_accepted');
  finishLocalAttempt(outbox,d.key,beginLocalAttempt(outbox,d.key).attempts,'receiver_duplicate');
  finishLocalAttempt(outbox,x.key,beginLocalAttempt(outbox,x.key).attempts,'permanent_failure');
  console.log('PASS: six durable synthetic outbox statuses plus missing-alert evidence created');

  stage='freeze local witness';
  freezeLocalWitness(audit,outbox,witness);
  const plan=inspectFrozenRecovery(audit,outbox,witness);
  assert.deepEqual(plan.counts,{pending:1,inFlight:1,retryPending:1,
    transportAccepted:1,receiverDuplicate:1,deadLetter:1,missingOutbox:1});
  assert.equal(plan.automaticReplayAuthorized,false);
  assert.equal(plan.humanAcknowledgementVerified,false);
  assert.equal(plan.independentExternalCustodyVerified,false);
  assertRefused(()=>freezeLocalWitness(audit,outbox,witness));
  console.log('PASS: frozen separate local witness verified audit head and complete outbox snapshot');

  stage='fresh-process recovery gate';
  processBoundaryCheck(audit,outbox,witness,i.key,plan.counts);
  assertRefused(()=>beginLocalAttempt(outbox,i.key));
  console.log('PASS: fresh Node process sees interrupted send and refuses ambiguous replay');

  stage='tamper and rollback refusal';
  const outPath=`${outbox}/${HANDOFF.file}`;
  const auditPath=`${audit}/maintenance-audit.jsonl`;
  const anchorPath=`${witness}/${RECOVERY.file}`;
  const originalOutbox=readFileSync(outPath,'utf8');
  const originalAudit=readFileSync(auditPath,'utf8');
  const originalWitness=readFileSync(anchorPath,'utf8');
  const data=JSON.parse(originalOutbox);
  data.records[0].humanAcknowledged=true;
  writeFileSync(outPath,JSON.stringify(data));
  assertRefused(()=>inspectFrozenRecovery(audit,outbox,witness));
  writeFileSync(outPath,originalOutbox);
  assert.equal(inspectFrozenRecovery(audit,outbox,witness).counts.missingOutbox,1);
  const first=originalAudit.split('\n')[0];
  writeFileSync(auditPath,`${first}\n`);
  assertRefused(()=>inspectFrozenRecovery(audit,outbox,witness));
  writeFileSync(auditPath,originalAudit);
  const witnessData=JSON.parse(originalWitness);
  witnessData.outboxCount=0;
  writeFileSync(anchorPath,JSON.stringify(witnessData));
  assertRefused(()=>inspectFrozenRecovery(audit,outbox,witness));
  writeFileSync(anchorPath,originalWitness);
  assert.equal(inspectFrozenRecovery(audit,outbox,witness).counts.inFlight,1);
  console.log('PASS: forged acknowledgement, history rollback and witness corruption rejected');

  stage='operator escalation remains unverified';
  assert.equal(plan.decision,'manual_review_required');
  assert.equal(RECOVERY.liveDelivery,false);
  assert.equal(RECOVERY.productionAuthorized,false);
  assert.equal(plan.counts.transportAccepted,1);
  assert.equal(plan.counts.receiverDuplicate,1);
  assert.equal(plan.counts.deadLetter,1);
  console.log('PASS: receiver acceptance is not human acknowledgement; dead-letter requires review');
  console.log('D15C-5G DISPOSABLE RECOVERY AND LOCAL WITNESS REHEARSAL PASSED');
  console.log('PUBLIC LAUNCH: NO_GO | NO external custody, actual operator, delivery or scheduler');
}
try { await main(); }
catch {
  // Never print path, local row, hash, credential, error, SQL or audit content.
  const stages=new Set(['create','initialize private review artifacts',
    'seed synthetic audit and outbox states','freeze local witness',
    'fresh-process recovery gate','tamper and rollback refusal',
    'operator escalation remains unverified']);
  const label=stages.has(stage)?stage.replaceAll(' ','_'):'unexpected';
  console.error(`REFUSE_D15C5G_REHEARSAL: stage=${label}`);
  status=1;
} finally {
  for (const [release,name] of [[releaseOutbox,'outbox'],[releaseAudit,'audit']]) {
    if (release) try { release(); }
    catch {status=1;console.error(`REFUSE_D15C5G_REHEARSAL: ${name}_lock_cleanup`);}
  }
  for (const dir of dirs.reverse()) {
    try {
      // Fail closed: only these exact, randomly created fixture directories.
      assert.match(dir,/^\/tmp\/pulse-(?:maint-audit|alert-handoff|alert-witness)-[a-f0-9]{10}$/);
      const known = dir.includes('maint-audit') ?
        ['maintenance-audit.jsonl','.pulse-maintenance-audit-marker'] :
        dir.includes('alert-handoff') ?
        [HANDOFF.file,HANDOFF.marker] : [RECOVERY.file,RECOVERY.marker];
      for (const file of known) {
        try { unlinkSync(`${dir}/${file}`); }
        catch (e) { if (e?.code !== 'ENOENT') throw e; }
      }
      rmdirSync(dir);
    } catch {status=1;console.error('REFUSE_D15C5G_REHEARSAL: private_fixture_cleanup');}
  }
  if (dirs.length === 3 && status === 0)
    console.log('PASS: three disposable private audit, outbox and witness directories removed');
}
process.exitCode=status;
