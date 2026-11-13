#!/usr/bin/env node
/**
 * D15C-5F LOCAL ONLY: an ephemeral fake HTTP receiver on 127.0.0.1 and a
 * private ephemeral 0700 test outbox. No real identities, URLs, migrations,
 * production alerts, scheduler, tenant data or external connections.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { constants, closeSync, mkdirSync, openSync, readFileSync,
  rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendAuditRecord, verifyAuditJournal } from './maintenance-audit-policy.mjs';
import { previewAlertFromAuditReceipt } from './operator-alert-contract.mjs';
import { HANDOFF, guardIsolatedRehearsal, readPrivateOutbox,
  queueAuditReceipt, beginLocalAttempt, finishLocalAttempt,
  acquireHandoffLock, makeSignedLocalEnvelope, verifySignedLocalEnvelope,
  sendToLoopbackTestSink, verifyReviewOnlyOperator,
} from './isolated-alert-handoff.mjs';

if (!guardIsolatedRehearsal()) {
  process.stdout.write('D15C5F_TEST {"event":"configuration_denied","live":false}\n');
  process.exit(1);
}

let stage = 'initialize';
let audit, handoff, server, release;
let created = false;
const secret = randomBytes(32); // ephemeral and NEVER printed or persisted
const planned = new Map();
const called = new Map();
const verified = new Map();

function privateDir(prefix, marker) {
  const dir = `/tmp/${prefix}-${randomBytes(5).toString('hex')}`;
  mkdirSync(dir,{mode:0o700});
  closeSync(openSync(`${dir}/${marker}`, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW,0o600));
  return dir;
}
function createFakeReceiver() {
  const http = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    const deny = code => { res.statusCode=code; res.end(); };
    if (req.socket.remoteAddress !== '127.0.0.1' || req.method !== 'POST' ||
        req.url !== HANDOFF.endpoint || req.headers['content-type'] !== 'application/json' ||
        req.headers['transfer-encoding'] ||
        Number(req.headers['content-length']) > 1536) return deny(403);
    let bytes = 0; const chunks=[];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1536) { chunks.length=0; req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      let envelope;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return deny(400); }
      const expected=verified.get(envelope?.key);
      if (!expected || !verifySignedLocalEnvelope(envelope,secret,expected))
        return deny(401);
      const attempts=planned.get(envelope.key);
      const calls=called.get(envelope.key) ?? 0;
      if (!attempts || envelope.attempt !== calls+1) return deny(403);
      called.set(envelope.key,calls+1);
      deny(attempts[calls] ?? 409);
    });
    req.on('error', () => {});
  });
  http.requestTimeout = 2000;
  http.headersTimeout = 2000;
  return http;
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address,'127.0.0.1');
  assert.equal(address.family,'IPv4');
  assert.ok(address.port >= 1024);
  return address.port;
}
async function sendOne(port, key) {
  const started = beginLocalAttempt(handoff,key);
  assert.equal(readPrivateOutbox(handoff).records.find(r=>r.key===key).status,'in_flight');
  const envelope = makeSignedLocalEnvelope(started,secret);
  let outcome;
  try { outcome=await sendToLoopbackTestSink(port,envelope); }
  catch { outcome='retryable'; }
  return finishLocalAttempt(handoff,key,started.attempts,outcome);
}
function register(receipt, codes) {
  const preview=previewAlertFromAuditReceipt(receipt);
  assert.equal(preview.disposition,'review_only_not_sent');
  const expected={key:preview.idempotencyKey,auditHash:preview.auditHash,
    auditSequence:preview.auditSequence,code:preview.code,severity:preview.severity};
  verified.set(preview.idempotencyKey,expected);
  planned.set(preview.idempotencyKey,codes);
  return queueAuditReceipt(handoff,receipt);
}
async function main() {
  stage='create private journal and outbox';
  audit=privateDir('pulse-maint-audit','.pulse-maintenance-audit-marker');
  handoff=privateDir('pulse-alert-handoff',HANDOFF.marker);
  created=true;
  release=acquireHandoffLock(handoff);

  stage='create synthetic reviewed audit receipts';
  const none=appendAuditRecord(audit,{status:'completed',alertCode:null,
    severity:'none',batches:1,networkRemoved:0,agentRemoved:0});
  const warning=appendAuditRecord(audit,{status:'completed',
    alertCode:'maintenance_possible_backlog',severity:'warning',
    batches:3,networkRemoved:750,agentRemoved:750});
  const critical=appendAuditRecord(audit,{status:'failed',
    alertCode:'maintenance_operation_failed',severity:'critical',
    batches:0,networkRemoved:0,agentRemoved:0});
  const duplicate=appendAuditRecord(audit,{status:'invalid_output',
    alertCode:'maintenance_protocol_invalid',severity:'critical',
    batches:0,networkRemoved:0,agentRemoved:0});
  const source=verifyAuditJournal(audit);
  assert.equal(source.sequence,4);
  assert.deepEqual(source.rows.map(r=>r.hash),[none.hash,warning.hash,
    critical.hash,duplicate.hash]);
  assert.equal(previewAlertFromAuditReceipt(none).disposition,'no_alert');
  assert.throws(()=>queueAuditReceipt(handoff,none));
  assert.equal(readPrivateOutbox(handoff).records.length,0);
  console.log('PASS: four linked synthetic audit records verified; no-alert ignored');

  stage='persist signed-alert handoff candidates';
  const w=register(warning,[503,202]);
  const c=register(critical,[503,503,503]);
  const d=register(duplicate,[409]);
  assert.equal(readPrivateOutbox(handoff).records.length,3);
  assert.equal(statSync(`${handoff}/outbox.json`).mode & 0o777,0o600);
  assert.equal(queueAuditReceipt(handoff,warning).key,w.key);
  assert.equal(readPrivateOutbox(handoff).records.length,3);
  console.log('PASS: 0600 private outbox durably queued exact SHA-backed candidates');

  stage='start ephemeral fake receiver';
  server=createFakeReceiver();
  const port=await listen(server);
  stage='reject forged signature';
  const fake=beginLocalAttempt(handoff,w.key);
  const forged=makeSignedLocalEnvelope(fake,randomBytes(32));
  assert.equal(await sendToLoopbackTestSink(port,forged),'permanent_failure');
  assert.equal(called.get(w.key)??0,0);
  // Forged test request did not change the real outbox's accepted state.
  assert.equal(readPrivateOutbox(handoff).records.find(r=>r.key===w.key).status,'in_flight');
  // Complete the legitimate in-flight attempt only after a real authenticated
  // 503 result. The first receiver call for this key remains attempt #1.
  const valid=makeSignedLocalEnvelope(fake,secret);
  assert.equal(await sendToLoopbackTestSink(port,valid),'retryable');
  assert.equal(finishLocalAttempt(handoff,w.key,1,'retryable').status,'retry_pending');
  assert.equal((await sendOne(port,w.key)).status,'transport_accepted');
  assert.equal(called.get(w.key),2);
  console.log('PASS: wrong HMAC rejected; 503 retried explicitly and 202 receipt persisted');

  stage='three-attempt failure and manual escalation';
  for(let i=1;i<=3;i++) {
    const result=await sendOne(port,c.key);
    assert.equal(result.attempts,i);
    assert.equal(result.status,i===3?'dead_letter':'retry_pending');
  }
  assert.throws(()=>beginLocalAttempt(handoff,c.key));
  assert.equal(called.get(c.key),3);
  console.log('PASS: three temporary failures dead-lettered without automatic retry loop');

  stage='receiver duplicate receipt';
  assert.equal((await sendOne(port,d.key)).status,'receiver_duplicate');
  assert.equal(queueAuditReceipt(handoff,duplicate).status,'receiver_duplicate');
  assert.equal(called.get(d.key),1);
  assert.throws(()=>beginLocalAttempt(handoff,d.key));
  console.log('PASS: receiver 409 is an idempotent transport receipt, not human acknowledgement');

  stage='strict test identity and tampering';
  const profile=verifyReviewOnlyOperator({deploymentEnabled:true});
  assert.equal(profile.productionAuthorized,false);
  assert.equal(profile.realOperatorAuthenticated,false);
  assert.equal(HANDOFF.liveDelivery,false);
  const before=readPrivateOutbox(handoff);
  assert.deepEqual(before.records.map(r=>r.status),[
    'transport_accepted','dead_letter','receiver_duplicate']);
  const saved=readFileSync(`${handoff}/outbox.json`,'utf8');
  writeFileSync(`${handoff}/outbox.json`,saved.replace('transport_accepted','sent_to_humans'));
  assert.throws(()=>readPrivateOutbox(handoff));
  assert.throws(()=>queueAuditReceipt(handoff,warning));
  console.log('PASS: malformed local outbox fails closed; proposed operator remains unverified');
  console.log('D15C-5F ISOLATED LOOPBACK DELIVERY REHEARSAL PASSED');
  console.log('PUBLIC LAUNCH: NO_GO | fake receiver only; no real operator, destination or scheduler');
}
let code=0;
try { await main(); }
catch {
  console.error(`REFUSE_D15C5F: stage=${[
    'initialize','create private journal and outbox',
    'create synthetic reviewed audit receipts','persist signed-alert handoff candidates',
    'start ephemeral fake receiver','reject forged signature',
    'three-attempt failure and manual escalation','receiver duplicate receipt',
    'strict test identity and tampering',
  ].includes(stage)?stage.replaceAll(' ','_'):'unexpected'}`);
  code=1;
} finally {
  if (server) {
    try { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
    catch { code=1; console.error('REFUSE_D15C5F: local receiver shutdown failed'); }
  }
  if (release) {
    try { release(); }
    catch { code=1; console.error('REFUSE_D15C5F: private handoff lock cleanup failed'); }
  }
  if (created) {
    try {
      // Only known, run-created names under two random, exact-pattern dirs;
      // never recursively remove a user-provided location.
      for (const name of [`${handoff}/outbox.json`,`${handoff}/${HANDOFF.marker}`,
                          `${audit}/maintenance-audit.jsonl`,
                          `${audit}/.pulse-maintenance-audit-marker`]) unlinkSync(name);
      rmdirSync(handoff); rmdirSync(audit);
      console.log('PASS: disposable private journal and outbox removed');
    } catch { code=1; console.error('REFUSE_D15C5F: temporary cleanup incomplete'); }
  }
  secret.fill(0);
}
process.exitCode=code;
