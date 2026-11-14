#!/usr/bin/env node
/** Pulse Metrics D15C-5H: disposable, OFFLINE signed evidence + decision rehearsal.
 * Signs with TWO DIFFERENT freshly generated Ed25519 identities. A verifier
 * child process receives ONLY their public keys and signed receipts. This
 * simulates trust separation but does NOT implement external custody, a real
 * authorized human operator, durable replay tracking, or any network send.
 */
import assert from 'node:assert/strict';
import {createHash,createPublicKey,generateKeyPairSync,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants,closeSync,mkdirSync,openSync,readFileSync,rmdirSync,
  unlinkSync,writeFileSync} from 'node:fs';
import {appendAuditRecord,acquireAuditJournalLock,verifyAuditJournal}
  from './maintenance-audit-policy.mjs';
import {HANDOFF,queueAuditReceipt,acquireHandoffLock,readPrivateOutbox,
  beginLocalAttempt} from './isolated-alert-handoff.mjs';
import {RECOVERY,freezeLocalWitness,readFrozenWitness,inspectFrozenRecovery}
  from './alert-recovery-anchor.mjs';
import {CUSTODY_ACK,createSyntheticCustodyAttestation,
  verifySyntheticCustodyAttestation,createSyntheticOperatorDecision,
  verifySyntheticOperatorDecision,verifyDecisionAgainstFrozenOutbox,guardCustodyAckRehearsal}
  from './custody-ack-contract.mjs';

if (!guardCustodyAckRehearsal()) {
  process.stdout.write('D15C5H_TEST {"event":"configuration_denied","live":false}\n');
  process.exit(1);
}
let stage='create'; let failed=false;
const dirs=[];let releaseAudit,releaseOutbox;
function fixture(prefix,marker) {
  const dir=`/tmp/${prefix}-${randomBytes(5).toString('hex')}`;
  mkdirSync(dir,{mode:0o700}); dirs.push(dir);
  closeSync(openSync(`${dir}/${marker}`,constants.O_CREAT|constants.O_EXCL|
    constants.O_WRONLY|constants.O_NOFOLLOW,0o600));return dir;
}
function row(audit,alert) {
  return appendAuditRecord(audit,alert==='critical'?
    {status:'failed',alertCode:'maintenance_operation_failed',severity:'critical',
      batches:0,networkRemoved:0,agentRemoved:0}:
    alert==='warning'?
    {status:'completed',alertCode:'maintenance_possible_backlog',severity:'warning',
      batches:3,networkRemoved:750,agentRemoved:750}:
    {status:'completed',alertCode:null,severity:'none',
      batches:1,networkRemoved:0,agentRemoved:0});
}
function childVerify(a,w,custKey,d,alert,operatorKey,trustedOutbox) {
  // No signing key is passed to this independent verifier Node process.
  const contract=new URL('./custody-ack-contract.mjs',import.meta.url).href;
  const src=`
    import {createPublicKey} from 'node:crypto';
    import {verifySyntheticCustodyAttestation,verifyDecisionAgainstFrozenOutbox}
      from ${JSON.stringify(contract)};
    const value=JSON.parse(await new Promise((resolve,reject)=>{
      let str='';process.stdin.setEncoding('utf8');
      process.stdin.on('data',b=>{str+=b;if(str.length>10000)reject(Error('oversize'))});
      process.stdin.on('end',()=>resolve(str));
    }));
    const key=(s)=>createPublicKey({key:Buffer.from(s,'base64'),format:'der',type:'spki'});
    if(!verifySyntheticCustodyAttestation(value.a,value.w,key(value.ck)))process.exit(2);
    const seen=new Set();
    if(!verifyDecisionAgainstFrozenOutbox(value.d,value.a,value.w,key(value.ck),
      value.outbox,value.r,key(value.ok),seen).accepted)process.exit(3);
    if(verifyDecisionAgainstFrozenOutbox(value.d,value.a,value.w,key(value.ck),
      value.outbox,value.r,key(value.ok),seen).accepted)process.exit(4);
    process.stdout.write('D15C5H_CHILD signed_receipts_verified_no_replay\\n');
  `;
  const payload={a,w,d,r:alert,outbox:trustedOutbox,
    ck:custKey.export({format:'der',type:'spki'}).toString('base64'),
    ok:operatorKey.export({format:'der',type:'spki'}).toString('base64')};
  const child=spawnSync(process.execPath,['--input-type=module','-e',src],{
    cwd:process.cwd(),input:JSON.stringify(payload),encoding:'utf8',timeout:8000,
    maxBuffer:8192,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:'/tmp',NODE_ENV:'test'},
  });
  assert.equal(child.signal,null);assert.equal(child.status,0);
  assert.equal(child.stdout,'D15C5H_CHILD signed_receipts_verified_no_replay\n');
  assert.equal(child.stderr,'');
}
try {
  stage='create_private_fixtures';
  const audit=fixture('pulse-maint-audit','.pulse-maintenance-audit-marker');
  const outbox=fixture('pulse-alert-handoff',HANDOFF.marker);
  const witness=fixture('pulse-alert-witness',RECOVERY.marker);
  releaseAudit=acquireAuditJournalLock(audit);
  releaseOutbox=acquireHandoffLock(outbox);
  stage='seed_and_freeze';
  const none=row(audit,'none');
  const warning=row(audit,'warning');
  const critical=row(audit,'critical');
  const queuedWarning=queueAuditReceipt(outbox,warning);
  const queuedCritical=queueAuditReceipt(outbox,critical);
  assert.throws(()=>queueAuditReceipt(outbox,none));
  assert.equal(beginLocalAttempt(outbox,queuedCritical.key).status,'in_flight');
  assert.equal(verifyAuditJournal(audit).sequence,3);
  assert.equal(readPrivateOutbox(outbox).records.length,2);
  freezeLocalWitness(audit,outbox,witness);
  const saved=readFrozenWitness(witness);
  assert.equal(inspectFrozenRecovery(audit,outbox,witness).counts.inFlight,1);
  console.log('PASS: original 5D–5G audit/outbox/witness verified, interrupted send remains blocked');

  stage='sign_and_verify_custody';
  const custodian=generateKeyPairSync('ed25519');
  const oncall=generateKeyPairSync('ed25519');
  assert.notDeepEqual(custodian.publicKey.export({type:'spki',format:'der'}),
    oncall.publicKey.export({type:'spki',format:'der'}));
  const att=createSyntheticCustodyAttestation(saved,custodian.privateKey,
    custodian.publicKey,randomBytes(16).toString('hex'));
  assert.equal(verifySyntheticCustodyAttestation(att,saved,custodian.publicKey),true);
  assert.equal(verifySyntheticCustodyAttestation(att,saved,oncall.publicKey),false);
  console.log('PASS: independently pinned synthetic custody public key validates signed frozen checkpoint');

  stage='sign_and_verify_decision';
  const decision=createSyntheticOperatorDecision(att,saved,custodian.publicKey,
    queuedCritical,oncall.privateKey,oncall.publicKey,'escalate_no_replay',
    randomBytes(16).toString('hex'));
  const seen=new Set();
  const sourceOutbox=readPrivateOutbox(outbox);
  assert.equal(verifyDecisionAgainstFrozenOutbox(decision,att,saved,custodian.publicKey,
    sourceOutbox,sourceOutbox.records.find(r=>r.key===queuedCritical.key),oncall.publicKey,seen).accepted,true);
  assert.equal(verifySyntheticOperatorDecision(decision,att,saved,custodian.publicKey,
    queuedCritical,oncall.publicKey,seen).accepted,false);
  assert.equal(verifySyntheticOperatorDecision(decision,att,saved,custodian.publicKey,
    queuedWarning,oncall.publicKey,new Set()).accepted,false);
  assert.equal(verifySyntheticOperatorDecision({...decision,decision:'retry'},att,saved,custodian.publicKey,
    queuedCritical,oncall.publicKey,new Set()).accepted,false);
  console.log('PASS: separate synthetic operator signature is alert-bound, replay-refused, and nonauthorizing');

  stage='fresh_process_verification';
  childVerify(att,saved,custodian.publicKey,decision,
    sourceOutbox.records.find(r=>r.key===queuedCritical.key),oncall.publicKey,sourceOutbox);
  console.log('PASS: fresh verifier process received public keys only; second-use nonce rejected');

  stage='mutated_source_refused';
  const path=`${outbox}/${HANDOFF.file}`;
  const original=readFileSync(path,'utf8');
  const modified=JSON.parse(original);
  modified.records[0].status='dead_letter';
  writeFileSync(path,JSON.stringify(modified));
  assert.throws(()=>inspectFrozenRecovery(audit,outbox,witness));
  writeFileSync(path,original);
  assert.equal(inspectFrozenRecovery(audit,outbox,witness).counts.inFlight,1);
  const altered={...saved,auditHead:'f'.repeat(64)};
  const {hash,...body}=altered;
  altered.hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  assert.equal(verifySyntheticCustodyAttestation(att,altered,custodian.publicKey),false);
  assert.equal(CUSTODY_ACK.realHumanAcknowledgement,false);
  assert.equal(CUSTODY_ACK.externalCustodyVerified,false);
  assert.equal(CUSTODY_ACK.automaticReplayAuthorized,false);
  console.log('PASS: source mutation/recomputed local witness rejected; no real human or external-custody claim');
  console.log('D15C-5H DISPOSABLE SIGNED CUSTODY AND OPERATOR-DECISION REHEARSAL PASSED');
  console.log('PUBLIC LAUNCH: NO_GO | synthetic identities only; no approval or delivery');
} catch {
  failed=true;console.error(`REFUSE_D15C5H_REHEARSAL: stage=${stage}`);
} finally {
  for(const [release,label] of [[releaseOutbox,'outbox'],[releaseAudit,'audit']]){
    try {release?.();} catch {failed=true;console.error(`REFUSE_D15C5H_REHEARSAL: ${label}_lock_cleanup`);}
  }
  for(const dir of dirs.reverse()){
    try {
      assert.match(dir,/^\/tmp\/pulse-(?:maint-audit|alert-handoff|alert-witness)-[a-f0-9]{10}$/);
      const files=dir.includes('maint-audit')?
        ['maintenance-audit.jsonl','.pulse-maintenance-audit-marker']:
        dir.includes('alert-handoff')?[HANDOFF.file,HANDOFF.marker]:
        [RECOVERY.file,RECOVERY.marker];
      for(const name of files){try{unlinkSync(`${dir}/${name}`);}catch(e){if(e?.code!=='ENOENT')throw e;}}
      rmdirSync(dir);
    } catch {failed=true;console.error('REFUSE_D15C5H_REHEARSAL: fixture_cleanup');}
  }
  if(!failed && dirs.length===3)
    console.log('PASS: three disposable private audit, outbox and witness directories removed');
}
process.exitCode=failed?1:0;
