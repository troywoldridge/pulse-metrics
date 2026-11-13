import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constants, closeSync, mkdirSync, openSync, readFileSync, rmdirSync,
  symlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { appendAuditRecord } from './maintenance-audit-policy.mjs';
import { HANDOFF, assertPrivateHandoffDirectory, readPrivateOutbox,
  queueAuditReceipt, beginLocalAttempt, finishLocalAttempt, acquireHandoffLock,
  makeSignedLocalEnvelope, verifySignedLocalEnvelope, classifyLoopbackResult,
  sendToLoopbackTestSink, guardIsolatedRehearsal, verifyReviewOnlyOperator,
} from './isolated-alert-handoff.mjs';

function dirs() {
  const suffix = randomBytes(5).toString('hex');
  const handoff = `/tmp/pulse-alert-handoff-${suffix}`;
  const audit = `/tmp/pulse-maint-audit-${suffix}`;
  for (const dir of [handoff, audit]) mkdirSync(dir, { mode:0o700 });
  const marker = `${handoff}/${HANDOFF.marker}`;
  const auditMarker = `${audit}/.pulse-maintenance-audit-marker`;
  for (const name of [marker, auditMarker])
    closeSync(openSync(name, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
  return { handoff, audit, cleanup() {
    for (const name of [
      `${handoff}/.outbox.pending`, `${handoff}/${HANDOFF.file}`,
      marker, `${audit}/maintenance-audit.jsonl`, auditMarker,
    ]) { try { unlinkSync(name); } catch {} }
    rmdirSync(audit); rmdirSync(handoff);
  }};
}
function row(dir, kind = 'maintenance_possible_backlog') {
  return appendAuditRecord(dir, kind === 'maintenance_possible_backlog' ?
    {status:'completed',alertCode:kind,severity:'warning',batches:3,
      networkRemoved:750,agentRemoved:750} :
    {status:'failed',alertCode:kind,severity:'critical',batches:0,
      networkRemoved:0,agentRemoved:0});
}
function withDirs(fn) {
  const x = dirs();
  try { return fn(x); } finally { x.cleanup(); }
}
const secret = () => randomBytes(32);

test('D15C-5F private directory requires exact 0700, owner-only marker', () => withDirs(x => {
  assert.doesNotThrow(() => assertPrivateHandoffDirectory(x.handoff));
  chmodSync(`${x.handoff}/${HANDOFF.marker}`,0o644);
  assert.throws(() => assertPrivateHandoffDirectory(x.handoff));
  chmodSync(`${x.handoff}/${HANDOFF.marker}`,0o600);
}));
test('D15C-5F journal alert queued durably before any attempt', () => withDirs(x => {
  const r = queueAuditReceipt(x.handoff,row(x.audit));
  assert.equal(r.status,'pending');
  assert.equal(r.attempts,0);
  assert.equal(readPrivateOutbox(x.handoff).records[0].key,r.key);
  assert.ok(!readFileSync(`${x.handoff}/${HANDOFF.file}`,'utf8').includes('password'));
}));
test('D15C-5F same audit receipt requeues without duplicate', () => withDirs(x => {
  const receipt = row(x.audit);
  const a = queueAuditReceipt(x.handoff,receipt);
  const b = queueAuditReceipt(x.handoff,receipt);
  assert.deepEqual(a,b);
  assert.equal(readPrivateOutbox(x.handoff).records.length,1);
}));
test('D15C-5F no-alert receipt must never enter outbox', () => withDirs(x => {
  const receipt = appendAuditRecord(x.audit,{status:'overlap_skipped',alertCode:null,
    severity:'none',batches:0,networkRemoved:0,agentRemoved:0});
  assert.throws(() => queueAuditReceipt(x.handoff, receipt));
  assert.equal(readPrivateOutbox(x.handoff).records.length,0);
}));
test('D15C-5F forged receipt and extra private fields rejected', () => withDirs(x => {
  const receipt = row(x.audit);
  for (const bad of [{...receipt,networkRemoved:2},{...receipt,password:'secret'}])
    assert.throws(() => queueAuditReceipt(x.handoff, bad));
}));
test('D15C-5F crash leaves in-flight state, refuses ambiguous replay', () => withDirs(x => {
  const r = queueAuditReceipt(x.handoff,row(x.audit));
  const a = beginLocalAttempt(x.handoff,r.key);
  assert.equal(a.status,'in_flight');
  assert.equal(a.attempts,1);
  assert.throws(() => beginLocalAttempt(x.handoff,r.key));
}));
test('D15C-5F transient failure retries are explicit and bounded to three', () => withDirs(x => {
  const r = queueAuditReceipt(x.handoff,row(x.audit));
  for (let attempt=1;attempt<=3;attempt++) {
    assert.equal(beginLocalAttempt(x.handoff,r.key).attempts,attempt);
    const result=finishLocalAttempt(x.handoff,r.key,attempt,'retryable');
    assert.equal(result.status,attempt===3?'dead_letter':'retry_pending');
  }
  assert.throws(() => beginLocalAttempt(x.handoff,r.key));
}));
test('D15C-5F 202 is transport acceptance, never human acknowledgement', () => withDirs(x => {
  const r=queueAuditReceipt(x.handoff,row(x.audit));
  beginLocalAttempt(x.handoff,r.key);
  const result=finishLocalAttempt(x.handoff,r.key,1,'transport_accepted');
  assert.equal(result.status,'transport_accepted');
  assert.ok(!Object.hasOwn(result,'humanAcknowledged'));
  assert.throws(() => beginLocalAttempt(x.handoff,r.key));
}));
test('D15C-5F 409 receiver duplicate is terminal and separate from acknowledgement', () => withDirs(x => {
  const r=queueAuditReceipt(x.handoff,row(x.audit));
  beginLocalAttempt(x.handoff,r.key);
  assert.equal(finishLocalAttempt(x.handoff,r.key,1,'receiver_duplicate').status,
    'receiver_duplicate');
}));
test('D15C-5F permanent errors are immediately dead-lettered', () => withDirs(x => {
  const r=queueAuditReceipt(x.handoff,row(x.audit));
  beginLocalAttempt(x.handoff,r.key);
  assert.equal(finishLocalAttempt(x.handoff,r.key,1,'permanent_failure').status,
    'dead_letter');
  assert.throws(() => beginLocalAttempt(x.handoff,r.key));
}));
test('D15C-5F stale or forged attempt cannot complete', () => withDirs(x => {
  const r=queueAuditReceipt(x.handoff,row(x.audit));
  beginLocalAttempt(x.handoff,r.key);
  assert.throws(() => finishLocalAttempt(x.handoff,r.key,0,'retryable'));
  assert.throws(() => finishLocalAttempt(x.handoff,r.key,1,'unexpected'));
}));
test('D15C-5F invalid outbox content cannot be used to send', () => withDirs(x => {
  const r=queueAuditReceipt(x.handoff,row(x.audit));
  writeFileSync(`${x.handoff}/${HANDOFF.file}`,'{"unexpected":"data"}',{mode:0o600});
  assert.throws(() => beginLocalAttempt(x.handoff,r.key));
}));
test('D15C-5F symlinked private outbox is refused', () => withDirs(x => {
  const path=`${x.handoff}/${HANDOFF.file}`;
  symlinkSync(`${x.audit}/maintenance-audit.jsonl`,path);
  assert.throws(() => readPrivateOutbox(x.handoff));
}));
test('D15C-5F local writer lock prevents second writer, never steals stale lock', () => withDirs(x => {
  const release=acquireHandoffLock(x.handoff);
  assert.throws(() => acquireHandoffLock(x.handoff));
  release(); assert.throws(release);
}));
test('D15C-5F HMAC signing verifies exact payload and independent test secret', () => withDirs(x => {
  const r=queueAuditReceipt(x.handoff,row(x.audit));
  const a=beginLocalAttempt(x.handoff,r.key);
  const s=secret();
  const e=makeSignedLocalEnvelope(a,s);
  const expected={key:r.key,auditHash:r.auditHash,auditSequence:r.auditSequence,
    code:r.code,severity:r.severity};
  assert.equal(verifySignedLocalEnvelope(e,s,expected),true);
  assert.equal(verifySignedLocalEnvelope(e,secret(),expected),false);
  assert.equal(verifySignedLocalEnvelope({...e,code:'maintenance_protocol_invalid'},s,expected),false);
  assert.equal(verifySignedLocalEnvelope(e,s,{...expected,auditHash:'f'.repeat(64)}),false);
}));
test('D15C-5F timestamps outside 30-second tolerance fail HMAC receiver guard', () => withDirs(x => {
  const r=queueAuditReceipt(x.handoff,row(x.audit));
  const a=beginLocalAttempt(x.handoff,r.key);
  const s=secret();
  const e=makeSignedLocalEnvelope(a,s,new Date('2020-01-01T00:00:00.000Z'));
  const expected={key:r.key,auditHash:r.auditHash,auditSequence:r.auditSequence,
    code:r.code,severity:r.severity};
  assert.equal(verifySignedLocalEnvelope(e,s,expected),false);
}));
test('D15C-5F only approved fake receiver HTTP status codes are classified', () => {
  const cases=[[202,'transport_accepted'],[409,'receiver_duplicate'],
    [503,'retryable'],[429,'retryable'],[401,'permanent_failure'],
    [403,'permanent_failure'],[302,'protocol_invalid'],[200,'protocol_invalid']];
  for(const [status,want] of cases) assert.equal(classifyLoopbackResult(status),want);
});
test('D15C-5F rejects nonlocal or nonnumeric port before connecting', async () => {
  for(const port of ['https://example.com',0,80,-1,65536,NaN])
    await assert.rejects(sendToLoopbackTestSink(port,{}));
});
test('D15C-5F unsafe configuration blocks trial before any network', () => {
  const base={PULSE_D15C5F_DISPOSABLE_ONLY:'YES'};
  assert.equal(guardIsolatedRehearsal(base,2),true);
  for(const changes of [{PULSE_D15C5F_DISPOSABLE_ONLY:''},
    {NODE_ENV:'production'}, {PGPASSWORD:'secret'},
    {DATABASE_URL:'postgresql://localhost/somedb'},
    {PULSE_D15C5F_DELIVERY_URL:'https://example.com'},
    {PULSE_D15C5F_LIVE_OPERATOR:'yes'}])
    assert.equal(guardIsolatedRehearsal({...base,...changes},2),false);
  assert.equal(guardIsolatedRehearsal(base,3),false);
});
test('D15C-5F proposed operator remains unverified even in test design', () => {
  const result=verifyReviewOnlyOperator({deploymentEnabled:true});
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.realOperatorAuthenticated,false);
  assert.equal(HANDOFF.liveDelivery,false);
});
