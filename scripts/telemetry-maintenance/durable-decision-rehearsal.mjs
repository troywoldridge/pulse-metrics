#!/usr/bin/env node
/**
 * D15C-5I: isolated OFFLINE crash/restart rehearsal. Separate ephemeral Ed25519
 * identities; child process gets signed receipts and public keys only. No
 * production grant, network, alert send, real human or external immutable store.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync, readFileSync,
  rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendAuditRecord, acquireAuditJournalLock, verifyAuditJournal }
  from './maintenance-audit-policy.mjs';
import { HANDOFF, queueAuditReceipt, beginLocalAttempt, acquireHandoffLock,
  readPrivateOutbox } from './isolated-alert-handoff.mjs';
import { RECOVERY, freezeLocalWitness, readFrozenWitness,
  inspectFrozenRecovery } from './alert-recovery-anchor.mjs';
import { createSyntheticCustodyAttestation, createSyntheticOperatorDecision }
  from './custody-ack-contract.mjs';
import { DURABLE_DECISION, recordSyntheticDecision, readSyntheticLedger,
  freezeSyntheticCustodyCheckpoint, verifySyntheticCustodyCheckpoint,
  guardDurableDecisionRehearsal } from './durable-decision-ledger.mjs';

if (!guardDurableDecisionRehearsal()) {
  process.stdout.write('D15C5I_TEST {"event":"configuration_denied","live":false}\n');
  process.exit(1);
}
let stage = 'start'; let failed = false;
const dirs = []; let releaseAudit; let releaseOutbox;
function fixture(prefix, marker) {
  const dir = `/tmp/${prefix}-${randomBytes(5).toString('hex')}`;
  mkdirSync(dir, { mode: 0o700 }); dirs.push(dir);
  closeSync(openSync(`${dir}/${marker}`, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  return dir;
}
function child(code, payload) {
  const launched = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(), input: JSON.stringify(payload), encoding: 'utf8',
    timeout: 8000, maxBuffer: 8192,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp', NODE_ENV: 'test' },
  });
  assert.equal(launched.signal, null);
  assert.equal(launched.stderr, '');
  return launched;
}
const baseUrl = new URL('./durable-decision-ledger.mjs', import.meta.url).href;
const readerCode = `
  import { createPublicKey } from 'node:crypto';
  import { verifySyntheticCustodyCheckpoint, recordSyntheticDecision,
    readSyntheticLedger } from ${JSON.stringify(baseUrl)};
  const p=JSON.parse(await new Promise((resolve,reject)=>{
    let text='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{
      text+=chunk;if(text.length>12000)reject(Error('oversize'));
    });process.stdin.on('end',()=>resolve(text));
  }));
  const key=s=>createPublicKey({key:Buffer.from(s,'base64'),format:'der',type:'spki'});
  const v=verifySyntheticCustodyCheckpoint(p.ledgerDir,p.custodyDir,key(p.checkpointPublic));
  if(!v.verified || v.automaticReplayAuthorized || v.externalCustodyVerified)process.exit(2);
  const ledger=readSyntheticLedger(p.ledgerDir);
  if(ledger.sequence!==1)process.exit(3);
  try {
    recordSyntheticDecision({dir:p.ledgerDir,decision:p.decision,
      attestation:p.attestation,witness:p.witness,
      trustedCustodianKey:key(p.custodianPublic),frozenOutbox:p.frozenOutbox,
      alert:p.alert,trustedOperatorKey:key(p.operatorPublic)});
    process.exit(4);
  } catch(error) {
    if(error?.message!=='synthetic_decision_refused')process.exit(5);
    process.stdout.write('D15C5I_CHILD restart_denies_duplicate_no_replay\\n');
  }
`;
const writerCode = `
  import {createPublicKey} from 'node:crypto';
  import {recordSyntheticDecision} from ${JSON.stringify(baseUrl)};
  const p=JSON.parse(await new Promise((resolve,reject)=>{
    let text='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{text+=chunk;if(text.length>12000)reject(Error('oversize'))});
    process.stdin.on('end',()=>resolve(text));
  }));
  const key=s=>createPublicKey({key:Buffer.from(s,'base64'),format:'der',type:'spki'});
  const result=recordSyntheticDecision({dir:p.ledgerDir,decision:p.decision,
    attestation:p.attestation,witness:p.witness,
    trustedCustodianKey:key(p.custodianPublic),frozenOutbox:p.frozenOutbox,
    alert:p.alert,trustedOperatorKey:key(p.operatorPublic)});
  if(!result.recorded || result.automaticReplayAuthorized)process.exit(4);
  // Deliberately stop after fsynced commit and before sending a receipt to parent.
  process.exit(71);
`;
const toPublic = key => key.export({ format: 'der', type: 'spki' }).toString('base64');
try {
  stage = 'create_five_disposable_directories';
  const auditDir = fixture('pulse-maint-audit', '.pulse-maintenance-audit-marker');
  const outboxDir = fixture('pulse-alert-handoff', HANDOFF.marker);
  const witnessDir = fixture('pulse-alert-witness', RECOVERY.marker);
  const ledgerDir = fixture('pulse-decision-ledger', DURABLE_DECISION.ledgerMarker);
  const custodyDir = fixture('pulse-custody-snapshot', DURABLE_DECISION.custodyMarker);
  releaseAudit = acquireAuditJournalLock(auditDir);
  releaseOutbox = acquireHandoffLock(outboxDir);

  stage = 'replay_existing_five_d_through_five_h_contracts';
  const noAlert = appendAuditRecord(auditDir, { status: 'completed', alertCode: null,
    severity: 'none', batches: 1, networkRemoved: 0, agentRemoved: 0 });
  const critical = appendAuditRecord(auditDir, { status: 'failed',
    alertCode: 'maintenance_operation_failed', severity: 'critical',
    batches: 0, networkRemoved: 0, agentRemoved: 0 });
  assert.equal(verifyAuditJournal(auditDir).sequence, 2);
  const queued = queueAuditReceipt(outboxDir, critical);
  assert.throws(() => queueAuditReceipt(outboxDir, noAlert));
  assert.equal(beginLocalAttempt(outboxDir, queued.key).status, 'in_flight');
  freezeLocalWitness(auditDir, outboxDir, witnessDir);
  const witness = readFrozenWitness(witnessDir);
  assert.equal(inspectFrozenRecovery(auditDir, outboxDir, witnessDir).counts.inFlight, 1);
  const frozenOutbox = readPrivateOutbox(outboxDir);
  const alert = frozenOutbox.records[0];
  const custodian = generateKeyPairSync('ed25519');
  const operator = generateKeyPairSync('ed25519');
  const checkpointSigner = generateKeyPairSync('ed25519');
  const attestation = createSyntheticCustodyAttestation(witness,
    custodian.privateKey, custodian.publicKey, randomBytes(16).toString('hex'));
  const decision = createSyntheticOperatorDecision(attestation, witness,
    custodian.publicKey, alert, operator.privateKey, operator.publicKey,
    'escalate_no_replay', randomBytes(16).toString('hex'));
  console.log('PASS: 5D–5H signed and frozen evidence verified; ambiguous in-flight send remains blocked');

  stage = 'simulate_crash_after_fsync';
  const payload = { ledgerDir, custodyDir, decision, attestation, witness, alert, frozenOutbox,
    custodianPublic: toPublic(custodian.publicKey),
    operatorPublic: toPublic(operator.publicKey),
    checkpointPublic: toPublic(checkpointSigner.publicKey) };
  const crashing = child(writerCode, payload);
  assert.equal(crashing.status, 71);
  assert.equal(crashing.stdout, '');
  assert.equal(readSyntheticLedger(ledgerDir).sequence, 1);
  console.log('PASS: separate writer exits without response AFTER fsynced decision; ledger survives crash');

  stage = 'freeze_separate_signed_checkpoint';
  freezeSyntheticCustodyCheckpoint(ledgerDir, custodyDir,
    checkpointSigner.privateKey, checkpointSigner.publicKey,
    randomBytes(16).toString('hex'));
  const observed = verifySyntheticCustodyCheckpoint(ledgerDir, custodyDir,
    checkpointSigner.publicKey);
  assert.equal(observed.verified, true);
  assert.equal(observed.externalCustodyVerified, false);
  console.log('PASS: separately signed test-only checkpoint pinned to durable ledger head');

  stage = 'fresh_process_no_private_keys';
  const restarted = child(readerCode, payload);
  assert.equal(restarted.status, 0);
  assert.equal(restarted.stdout, 'D15C5I_CHILD restart_denies_duplicate_no_replay\n');
  console.log('PASS: fresh verifier with public keys only rejects replay after restart');

  stage = 'recomputed_hash_refused';
  const path = `${ledgerDir}/${DURABLE_DECISION.ledgerFile}`;
  const original = readFileSync(path, 'utf8');
  const edited = JSON.parse(original);
  edited.nonce = 'f'.repeat(32);
  const { hash: ignored, ...body } = edited;
  edited.hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  writeFileSync(path, `${JSON.stringify(edited)}\n`);
  assert.equal(readSyntheticLedger(ledgerDir).sequence, 1);
  assert.throws(() => verifySyntheticCustodyCheckpoint(ledgerDir, custodyDir,
    checkpointSigner.publicKey));
  writeFileSync(path, original);
  assert.equal(verifySyntheticCustodyCheckpoint(ledgerDir, custodyDir,
    checkpointSigner.publicKey).verified, true);
  console.log('PASS: rewritten hash-linked ledger cannot bypass separately signed frozen checkpoint');

  stage = 'missing_and_tampered_checkpoint';
  const cp = `${custodyDir}/${DURABLE_DECISION.checkpointFile}`;
  const savedCheckpoint = readFileSync(cp, 'utf8');
  const forged = JSON.parse(savedCheckpoint);
  forged.signature = 'a'.repeat(86);
  writeFileSync(cp, JSON.stringify(forged));
  assert.throws(() => verifySyntheticCustodyCheckpoint(ledgerDir, custodyDir,
    checkpointSigner.publicKey));
  writeFileSync(cp, savedCheckpoint);
  assert.equal(verifySyntheticCustodyCheckpoint(ledgerDir, custodyDir,
    checkpointSigner.publicKey).verified, true);
  console.log('PASS: forged checkpoint refused; no human, external custody or live authorization claimed');
  console.log('D15C-5I DISPOSABLE DURABLE NONCE AND SIGNED CHECKPOINT REHEARSAL PASSED');
  console.log('PUBLIC LAUNCH: NO_GO | no real custody, humans, delivery, DB or scheduler');
} catch {
  failed = true;
  console.error(`REFUSE_D15C5I_REHEARSAL: stage=${stage}`);
} finally {
  for (const [release, name] of [[releaseOutbox, 'outbox'], [releaseAudit, 'audit']]) {
    try { release?.(); } catch { failed = true; console.error(`REFUSE_D15C5I_REHEARSAL: ${name}_unlock`); }
  }
  for (const dir of dirs.reverse()) {
    try {
      assert.match(dir, /^\/tmp\/pulse-(?:maint-audit|alert-handoff|alert-witness|decision-ledger|custody-snapshot)-[a-f0-9]{10}$/);
      const files = dir.includes('maint-audit') ?
        ['maintenance-audit.jsonl', '.pulse-maintenance-audit-marker'] :
        dir.includes('alert-handoff') ? [HANDOFF.file, HANDOFF.marker] :
        dir.includes('alert-witness') ? [RECOVERY.file, RECOVERY.marker] :
        dir.includes('decision-ledger') ? [DURABLE_DECISION.ledgerFile, DURABLE_DECISION.ledgerMarker] :
        [DURABLE_DECISION.checkpointFile, DURABLE_DECISION.custodyMarker];
      for (const file of files) {
        try { unlinkSync(`${dir}/${file}`); }
        catch (e) { if (e?.code !== 'ENOENT') throw e; }
      }
      rmdirSync(dir);
    } catch { failed = true; console.error('REFUSE_D15C5I_REHEARSAL: fixture_cleanup'); }
  }
  if (!failed && dirs.length === 5)
    console.log('PASS: five disposable private audit, outbox, witness, ledger and checkpoint directories removed');
}
process.exitCode = failed ? 1 : 0;
