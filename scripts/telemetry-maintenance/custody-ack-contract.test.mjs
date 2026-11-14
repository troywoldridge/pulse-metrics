import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, randomBytes} from 'node:crypto';
import {CUSTODY_ACK,createSyntheticCustodyAttestation,verifySyntheticCustodyAttestation,
  createSyntheticOperatorDecision,verifySyntheticOperatorDecision,
  guardCustodyAckRehearsal} from './custody-ack-contract.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const keys=()=>generateKeyPairSync('ed25519');
const custody=keys(),operator=keys(),attacker=keys();
const witness=()=>{const b={schema:'pulse-local-alert-witness/v1',auditSequence:3,
  auditHead:'a'.repeat(64),outboxCount:2,outboxHash:'b'.repeat(64),
  missingOutbox:0,createdAt:new Date().toISOString()};return {...b,hash:sha(JSON.stringify(b))};};
const alert=()=>({key:'c'.repeat(64),auditHash:'d'.repeat(64),auditSequence:2,
  code:'maintenance_operation_failed',severity:'critical',status:'in_flight',
  attempts:1,lastOutcome:null});
const n=()=>randomBytes(16).toString('hex');
const setup=()=>{const w=witness(); const a=createSyntheticCustodyAttestation(w,custody.privateKey,custody.publicKey,n());
  const r=alert();const d=createSyntheticOperatorDecision(a,w,custody.publicKey,r,
    operator.privateKey,operator.publicKey,'escalate_no_replay',n());return {w,a,r,d};};
test('D15C-5H baseline verifies trusted custody signature',()=>{const {w,a}=setup();
  assert.equal(verifySyntheticCustodyAttestation(a,w,custody.publicKey),true);});
test('D15C-5H signing key is never embedded into custody receipt',()=>{const {a}=setup();
  assert.equal(Object.hasOwn(a,'privateKey'),false);assert.equal(Object.hasOwn(a,'publicKey'),false);
  assert.equal(JSON.stringify(a).includes('BEGIN'),false);});
test('D15C-5H unrelated custodian key never validates',()=>{const {w,a}=setup();
  assert.equal(verifySyntheticCustodyAttestation(a,w,attacker.publicKey),false);});
test('D15C-5H tampered custody signature rejected',()=>{const {w,a}=setup();
  assert.equal(verifySyntheticCustodyAttestation({...a,signature:'A'.repeat(86)},w,custody.publicKey),false);});
test('D15C-5H custody cannot replace trusted witness head',()=>{const {w,a}=setup();
  const changed={...w,auditHead:'e'.repeat(64)}; const {hash,...body}=changed;
  changed.hash=sha(JSON.stringify(body));
  assert.equal(verifySyntheticCustodyAttestation(a,changed,custody.publicKey),false);});
test('D15C-5H re-computed local witness chain alone cannot forge custody',()=>{const {w,a}=setup();
  const changed={...w,outboxHash:'f'.repeat(64)};const {hash,...body}=changed;
  changed.hash=sha(JSON.stringify(body));
  assert.equal(verifySyntheticCustodyAttestation(a,changed,custody.publicKey),false);});
test('D15C-5H extra unsigned custody fields rejected',()=>{const {w,a}=setup();
  assert.equal(verifySyntheticCustodyAttestation({...a,endpoint:'https://example.com'},w,custody.publicKey),false);});
test('D15C-5H malformed local witness shape rejected',()=>{const {w,a}=setup();
  assert.equal(verifySyntheticCustodyAttestation(a,{...w,role:'admin'},custody.publicKey),false);});
test('D15C-5H malformed detached signatures rejected',()=>{const {w,a}=setup();
  for(const sig of ['','/'.repeat(86),'A'.repeat(85),'A'.repeat(88)])
    assert.equal(verifySyntheticCustodyAttestation({...a,signature:sig},w,custody.publicKey),false);});
test('D15C-5H custody key mismatch cannot mint attestation',()=>{const w=witness();
  assert.throws(()=>createSyntheticCustodyAttestation(w,custody.privateKey,attacker.publicKey,n()));});
test('D15C-5H accepted synthetic operator decision does not grant replay',()=>{const {w,a,r,d}=setup();
  const result=verifySyntheticOperatorDecision(d,a,w,custody.publicKey,r,operator.publicKey,new Set());
  assert.deepEqual(result,{accepted:true,action:'synthetic_decision_recorded_only',
    automaticReplayAuthorized:false,realHumanAcknowledgement:false});});
test('D15C-5H replayed nonce rejected by explicit ledger',()=>{const {w,a,r,d}=setup(); const seen=new Set();
  assert.equal(verifySyntheticOperatorDecision(d,a,w,custody.publicKey,r,operator.publicKey,seen).accepted,true);
  assert.equal(verifySyntheticOperatorDecision(d,a,w,custody.publicKey,r,operator.publicKey,seen).accepted,false);});
test('D15C-5H operator signature not valid under other public key',()=>{const {w,a,r,d}=setup();
  assert.equal(verifySyntheticOperatorDecision(d,a,w,custody.publicKey,r,attacker.publicKey,new Set()).accepted,false);});
test('D15C-5H custodian key cannot masquerade as operator',()=>{const {w,a,r,d}=setup();
  assert.equal(verifySyntheticOperatorDecision(d,a,w,custody.publicKey,r,custody.publicKey,new Set()).accepted,false);});
test('D15C-5H forged operator decision fails signature',()=>{const {w,a,r,d}=setup();
  assert.equal(verifySyntheticOperatorDecision({...d,decision:'review_no_replay'},a,w,custody.publicKey,r,operator.publicKey,new Set()).accepted,false);});
test('D15C-5H modified alert binding rejected',()=>{const {w,a,r,d}=setup();
  assert.equal(verifySyntheticOperatorDecision(d,a,w,custody.publicKey,{...r,key:'e'.repeat(64)},operator.publicKey,new Set()).accepted,false);});
test('D15C-5H modified source attestation rejected',()=>{const {w,a,r,d}=setup();
  assert.equal(verifySyntheticOperatorDecision(d,{...a,nonce:n()},w,custody.publicKey,r,operator.publicKey,new Set()).accepted,false);});
test('D15C-5H unsigned extra decision fields rejected',()=>{const {w,a,r,d}=setup();
  assert.equal(verifySyntheticOperatorDecision({...d,approved:true},a,w,custody.publicKey,r,operator.publicKey,new Set()).accepted,false);});
test('D15C-5H stale acknowledgement cannot authorize decision',()=>{const {w,a,r,d}=setup();
  const inFuture=Date.parse(d.issuedAt)+301000;
  assert.equal(verifySyntheticOperatorDecision(d,a,w,custody.publicKey,r,operator.publicKey,new Set(),inFuture).accepted,false);});
test('D15C-5H no replay state fails closed',()=>{const {w,a,r,d}=setup();
  assert.equal(verifySyntheticOperatorDecision(d,a,w,custody.publicKey,r,operator.publicKey,undefined).accepted,false);});
test('D15C-5H bad operator identity, decision or malformed alert refused',()=>{const {w,a,r,d}=setup();
  for(const bad of [{...d,operator:'real_ceo'},{...d,decision:'retry'},{...d,nonce:'zz'}])
    assert.equal(verifySyntheticOperatorDecision(bad,a,w,custody.publicKey,r,operator.publicKey,new Set()).accepted,false);
  assert.throws(()=>createSyntheticOperatorDecision(a,w,custody.publicKey,{...r,customerId:'secret'},
    operator.privateKey,operator.publicKey,'escalate_no_replay',n()));});
test('D15C-5H zero live capability invariant',()=>{
  assert.equal(CUSTODY_ACK.realHumanAcknowledgement,false);
  assert.equal(CUSTODY_ACK.externalCustodyVerified,false);
  assert.equal(CUSTODY_ACK.automaticReplayAuthorized,false);
  assert.equal(CUSTODY_ACK.productionAuthorized,false);});
test('D15C-5H hard guard denies prod, PG env, URLs and argv',()=>{const b={PULSE_D15C5H_DISPOSABLE_ONLY:'YES',NODE_ENV:'test'};
  assert.equal(guardCustodyAckRehearsal(b,2),true);
  for(const e of [{PULSE_D15C5H_DISPOSABLE_ONLY:''},{NODE_ENV:'production'},{PGPASSWORD:'secret'},
    {DATABASE_URL:'postgres://test'},{PULSE_D15C5H_DELIVERY_URL:'https://test'},
    {PULSE_D15C5H_EXTERNAL_CUSTODY:'yes'},{PULSE_D15C5H_LIVE_OPERATOR:'yes'},
    {PULSE_D15C5H_APPROVE:'yes'}])assert.equal(guardCustodyAckRehearsal({...b,...e},2),false);
  assert.equal(guardCustodyAckRehearsal(b,3),false);
});

test('D15C-5H full frozen outbox membership is required before nonce consumption',async()=>{
  const {verifyDecisionAgainstFrozenOutbox}=await import('./custody-ack-contract.mjs');
  const r=alert();const outbox={schema:'pulse-local-alert-handoff/v1',records:[r]};
  const old=witness(); const body={...old,outboxCount:1,outboxHash:sha(JSON.stringify(outbox))};
  delete body.hash;const w={...body,hash:sha(JSON.stringify(body))};
  const a=createSyntheticCustodyAttestation(w,custody.privateKey,custody.publicKey,n());
  const d=createSyntheticOperatorDecision(a,w,custody.publicKey,r,
    operator.privateKey,operator.publicKey,'review_no_replay',n());
  const seen=new Set();
  assert.equal(verifyDecisionAgainstFrozenOutbox(d,a,w,custody.publicKey,outbox,r,
    operator.publicKey,seen).accepted,true);
  assert.equal(verifyDecisionAgainstFrozenOutbox(d,a,w,custody.publicKey,outbox,r,
    operator.publicKey,seen).accepted,false);
  assert.equal(seen.size,1);
});
test('D15C-5H rewritten or omitted frozen outbox rejects signed decision',async()=>{
  const {verifyDecisionAgainstFrozenOutbox}=await import('./custody-ack-contract.mjs');
  const r=alert();const outbox={schema:'pulse-local-alert-handoff/v1',records:[r]};
  const old=witness(); const body={...old,outboxCount:1,outboxHash:sha(JSON.stringify(outbox))};
  delete body.hash;const w={...body,hash:sha(JSON.stringify(body))};
  const a=createSyntheticCustodyAttestation(w,custody.privateKey,custody.publicKey,n());
  const d=createSyntheticOperatorDecision(a,w,custody.publicKey,r,
    operator.privateKey,operator.publicKey,'review_no_replay',n());
  for(const altered of [
    {schema:outbox.schema,records:[]},
    {schema:outbox.schema,records:[{...r,status:'dead_letter'}]},
    {schema:outbox.schema,records:[{...r,key:'e'.repeat(64)}]},
    {...outbox,extra:true}
  ]) assert.equal(verifyDecisionAgainstFrozenOutbox(d,a,w,custody.publicKey,
    altered,r,operator.publicKey,new Set()).accepted,false);
});
