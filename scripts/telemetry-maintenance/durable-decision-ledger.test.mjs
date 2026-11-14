import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync,
  rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { appendAuditRecord, acquireAuditJournalLock } from './maintenance-audit-policy.mjs';
import { HANDOFF, queueAuditReceipt, beginLocalAttempt, acquireHandoffLock,
  readPrivateOutbox } from './isolated-alert-handoff.mjs';
import { RECOVERY, freezeLocalWitness, readFrozenWitness,
  inspectFrozenRecovery } from './alert-recovery-anchor.mjs';
import { createSyntheticCustodyAttestation, createSyntheticOperatorDecision }
  from './custody-ack-contract.mjs';
import {
  DURABLE_DECISION, assertPrivateDecisionLedger, assertPrivateCustodySnapshot,
  readSyntheticLedger, recordSyntheticDecision, freezeSyntheticCustodyCheckpoint,
  verifySyntheticCustodyCheckpoint, guardDurableDecisionRehearsal,
} from './durable-decision-ledger.mjs';

function mkDir(prefix, marker) {
  const dir = `/tmp/${prefix}-${randomBytes(5).toString('hex')}`;
  mkdirSync(dir, { mode: 0o700 });
  closeSync(openSync(`${dir}/${marker}`, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  return dir;
}
function cleanupDir(dir, files) {
  for (const file of files) {
    try { unlinkSync(`${dir}/${file}`); }
    catch (e) { if (e?.code !== 'ENOENT') throw e; }
  }
  rmdirSync(dir);
}
function setup() {
  const dirs = [];
  let releaseAudit, releaseOutbox;
  const audit = mkDir('pulse-maint-audit', '.pulse-maintenance-audit-marker'); dirs.push(audit);
  const outbox = mkDir('pulse-alert-handoff', HANDOFF.marker); dirs.push(outbox);
  const witnessDir = mkDir('pulse-alert-witness', RECOVERY.marker); dirs.push(witnessDir);
  const ledgerDir = mkDir('pulse-decision-ledger', DURABLE_DECISION.ledgerMarker); dirs.push(ledgerDir);
  const custodyDir = mkDir('pulse-custody-snapshot', DURABLE_DECISION.custodyMarker); dirs.push(custodyDir);
  releaseAudit = acquireAuditJournalLock(audit);
  releaseOutbox = acquireHandoffLock(outbox);
  const source = appendAuditRecord(audit, {
    status: 'failed', alertCode: 'maintenance_operation_failed', severity: 'critical',
    batches: 0, networkRemoved: 0, agentRemoved: 0,
  });
  const queued = queueAuditReceipt(outbox, source);
  beginLocalAttempt(outbox, queued.key);
  freezeLocalWitness(audit, outbox, witnessDir);
  const witness = readFrozenWitness(witnessDir);
  assert.equal(inspectFrozenRecovery(audit, outbox, witnessDir).counts.inFlight, 1);
  const custodian = generateKeyPairSync('ed25519');
  const operator = generateKeyPairSync('ed25519');
  const checkpointSigner = generateKeyPairSync('ed25519');
  const attestation = createSyntheticCustodyAttestation(witness,
    custodian.privateKey, custodian.publicKey, randomBytes(16).toString('hex'));
  const frozenOutbox = readPrivateOutbox(outbox);
  const alert = frozenOutbox.records[0];
  const decision = createSyntheticOperatorDecision(attestation, witness,
    custodian.publicKey, alert, operator.privateKey, operator.publicKey,
    'escalate_no_replay', randomBytes(16).toString('hex'));
  const args = { dir: ledgerDir, decision, attestation, witness,
    trustedCustodianKey: custodian.publicKey, frozenOutbox, alert,
    trustedOperatorKey: operator.publicKey };
  return {
    ...args, audit, outbox, witnessDir, ledgerDir, custodyDir, custodian, operator,
    checkpointSigner,
    record: () => recordSyntheticDecision(args),
    checkpoint: () => freezeSyntheticCustodyCheckpoint(ledgerDir, custodyDir,
      checkpointSigner.privateKey, checkpointSigner.publicKey, randomBytes(16).toString('hex')),
    verify: () => verifySyntheticCustodyCheckpoint(ledgerDir, custodyDir,
      checkpointSigner.publicKey),
    cleanup: () => {
      releaseOutbox(); releaseAudit();
      cleanupDir(custodyDir, [DURABLE_DECISION.checkpointFile, DURABLE_DECISION.custodyMarker]);
      cleanupDir(ledgerDir, [DURABLE_DECISION.ledgerFile, DURABLE_DECISION.ledgerMarker]);
      cleanupDir(witnessDir, [RECOVERY.file, RECOVERY.marker]);
      cleanupDir(outbox, [HANDOFF.file, HANDOFF.marker]);
      cleanupDir(audit, ['maintenance-audit.jsonl', '.pulse-maintenance-audit-marker']);
    },
  };
}
function check(fn) {
  const f = setup();
  try { fn(f); } finally { f.cleanup(); }
}

test('D15C-5I declares no production or automatic replay authorization', () => {
  assert.equal(DURABLE_DECISION.publicLaunch, 'NO_GO');
  assert.equal(DURABLE_DECISION.automaticReplayAuthorized, false);
  assert.equal(DURABLE_DECISION.realHumanAcknowledgement, false);
  assert.equal(DURABLE_DECISION.independentExternalCustody, false);
});
test('D15C-5I initial ledger is empty and private', () => check(f => {
  assertPrivateDecisionLedger(f.ledgerDir);
  assertPrivateCustodySnapshot(f.custodyDir);
  assert.deepEqual(readSyntheticLedger(f.ledgerDir), { sequence: 0, head: '0'.repeat(64), rows: [] });
}));
test('D15C-5I signed frozen alert records one durable nonauthorizing decision', () => check(f => {
  const result = f.record();
  assert.equal(result.recorded, true);
  assert.equal(result.automaticReplayAuthorized, false);
  assert.equal(result.realHumanAcknowledgement, false);
  const ledger = readSyntheticLedger(f.ledgerDir);
  assert.equal(ledger.sequence, 1);
  assert.equal(ledger.head, result.head);
  assert.equal(ledger.rows[0].nonce, f.decision.nonce);
}));
test('D15C-5I same signed decision nonce is rejected after file reload', () => check(f => {
  f.record(); readSyntheticLedger(f.ledgerDir);
  assert.throws(() => f.record());
  assert.equal(readSyntheticLedger(f.ledgerDir).sequence, 1);
}));
test('D15C-5I same alert cannot be recorded twice using a new signed nonce', () => check(f => {
  f.record();
  const second = createSyntheticOperatorDecision(f.attestation, f.witness,
    f.custodian.publicKey, f.alert, f.operator.privateKey, f.operator.publicKey,
    'review_no_replay', randomBytes(16).toString('hex'));
  assert.throws(() => recordSyntheticDecision({ ...f, decision: second }));
  assert.equal(readSyntheticLedger(f.ledgerDir).sequence, 1);
}));
test('D15C-5I unrelated trusted operator key is never accepted', () => check(f => {
  const rogue = generateKeyPairSync('ed25519');
  assert.throws(() => recordSyntheticDecision({ ...f, trustedOperatorKey: rogue.publicKey }));
  assert.equal(readSyntheticLedger(f.ledgerDir).sequence, 0);
}));
test('D15C-5I forged decision and extra unsigned fields fail before ledger write', () => check(f => {
  for (const decision of [{ ...f.decision, nonce: randomBytes(16).toString('hex') },
    { ...f.decision, operatorApproval: true }]) {
    assert.throws(() => recordSyntheticDecision({ ...f, decision }));
  }
  assert.equal(readSyntheticLedger(f.ledgerDir).sequence, 0);
}));
test('D15C-5I omitted alert or forged frozen outbox rejects before ledger write', () => check(f => {
  assert.throws(() => recordSyntheticDecision({ ...f,
    frozenOutbox: { ...f.frozenOutbox, records: [] } }));
  assert.throws(() => recordSyntheticDecision({ ...f,
    alert: { ...f.alert, status: 'dead_letter' } }));
  assert.equal(readSyntheticLedger(f.ledgerDir).sequence, 0);
}));
test('D15C-5I a frozen checkpoint verifies without a signing private key', () => check(f => {
  f.record(); f.checkpoint();
  assert.deepEqual(f.verify(), {
    verified: true, sequence: 1, manualReviewRequired: true,
    automaticReplayAuthorized: false, realHumanAcknowledgement: false,
    externalCustodyVerified: false,
  });
}));
test('D15C-5I second checkpoint cannot replace the first', () => check(f => {
  f.record(); f.checkpoint();
  assert.throws(() => f.checkpoint());
  assert.equal(f.verify().verified, true);
}));
test('D15C-5I wrong separately trusted checkpoint public key fails', () => check(f => {
  f.record(); f.checkpoint();
  const rogue = generateKeyPairSync('ed25519');
  assert.throws(() => verifySyntheticCustodyCheckpoint(f.ledgerDir,
    f.custodyDir, rogue.publicKey));
}));
test('D15C-5I mismatched signer and pinned key fail before snapshot creation', () => check(f => {
  f.record();
  const rogue = generateKeyPairSync('ed25519');
  assert.throws(() => freezeSyntheticCustodyCheckpoint(f.ledgerDir,
    f.custodyDir, rogue.privateKey, f.checkpointSigner.publicKey,
    randomBytes(16).toString('hex')));
  assert.throws(() => f.verify());
}));
test('D15C-5I modified decision hash is detected before checkpoint verification', () => check(f => {
  f.record(); f.checkpoint();
  const path = `${f.ledgerDir}/${DURABLE_DECISION.ledgerFile}`;
  const src = readFileSync(path, 'utf8');
  writeFileSync(path, src.replace(f.decision.nonce, 'f'.repeat(32)));
  assert.throws(() => f.verify());
  writeFileSync(path, src);
  assert.equal(f.verify().verified, true);
}));
test('D15C-5I recomputed valid-looking ledger hash cannot replace signed checkpoint', () => check(f => {
  f.record(); f.checkpoint();
  const path = `${f.ledgerDir}/${DURABLE_DECISION.ledgerFile}`;
  const row = JSON.parse(readFileSync(path, 'utf8'));
  row.nonce = 'f'.repeat(32);
  const { hash: ignored, ...body } = row;
  row.hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  writeFileSync(path, `${JSON.stringify(row)}\n`);
  assert.equal(readSyntheticLedger(f.ledgerDir).sequence, 1);
  assert.throws(() => f.verify());
}));
test('D15C-5I truncated ledger is not silently repaired', () => check(f => {
  f.record(); f.checkpoint();
  writeFileSync(`${f.ledgerDir}/${DURABLE_DECISION.ledgerFile}`, '');
  assert.throws(() => f.verify());
  assert.throws(() => f.record());
}));
test('D15C-5I missing ledger after checkpoint is rejected', () => check(f => {
  f.record(); f.checkpoint();
  unlinkSync(`${f.ledgerDir}/${DURABLE_DECISION.ledgerFile}`);
  assert.throws(() => f.verify());
}));
test('D15C-5I missing checkpoint is not mistaken for proof', () => check(f => {
  f.record(); assert.throws(() => f.verify());
}));
test('D15C-5I altered checkpoint signature and extra fields are refused', () => check(f => {
  f.record(); f.checkpoint();
  const path = `${f.custodyDir}/${DURABLE_DECISION.checkpointFile}`;
  const original = readFileSync(path, 'utf8');
  const altered = JSON.parse(original); altered.signature = 'a'.repeat(86);
  writeFileSync(path, JSON.stringify(altered)); assert.throws(() => f.verify());
  altered.signature = JSON.parse(original).signature; altered.approved = true;
  writeFileSync(path, JSON.stringify(altered)); assert.throws(() => f.verify());
}));
test('D15C-5I duplicate JSON keys in private checkpoint fail closed', () => check(f => {
  f.record(); f.checkpoint();
  const path = `${f.custodyDir}/${DURABLE_DECISION.checkpointFile}`;
  const src = readFileSync(path, 'utf8');
  writeFileSync(path, src.replace('{', '{"schema":"duplicate",'));
  assert.throws(() => f.verify());
}));
test('D15C-5I loose file permissions are refused without repair', () => check(f => {
  f.record();
  const path = `${f.ledgerDir}/${DURABLE_DECISION.ledgerFile}`;
  chmodSync(path, 0o644);
  assert.throws(() => readSyntheticLedger(f.ledgerDir));
  chmodSync(path, 0o600);
}));
test('D15C-5I symbolic and dangling ledger targets are refused', () => check(f => {
  const path = `${f.ledgerDir}/${DURABLE_DECISION.ledgerFile}`;
  symlinkSync('/tmp/does-not-exist-d15c5i', path);
  assert.throws(() => readSyntheticLedger(f.ledgerDir));
  assert.throws(() => f.record());
}));
test('D15C-5I stale writer lock blocks operations instead of being stolen', () => check(f => {
  const lock = `${f.ledgerDir}/.synthetic-ledger-writer-lock`;
  mkdirSync(lock, { mode: 0o700 });
  try { assert.throws(() => f.record()); }
  finally { rmdirSync(lock); }
}));
test('D15C-5I untrusted directory and marker permissions refuse access', () => check(f => {
  chmodSync(f.ledgerDir, 0o755);
  assert.throws(() => readSyntheticLedger(f.ledgerDir));
  chmodSync(f.ledgerDir, 0o700);
  chmodSync(`${f.ledgerDir}/${DURABLE_DECISION.ledgerMarker}`, 0o644);
  assert.throws(() => readSyntheticLedger(f.ledgerDir));
  chmodSync(`${f.ledgerDir}/${DURABLE_DECISION.ledgerMarker}`, 0o600);
}));
test('D15C-5I signer rejection when no recorded ledger exists', () => check(f => {
  assert.throws(() => f.checkpoint());
}));
test('D15C-5I unsafe runtime environment and argv are blocked', () => {
  const clean = { PULSE_D15C5I_DISPOSABLE_ONLY: 'YES', NODE_ENV: 'test' };
  assert.equal(guardDurableDecisionRehearsal(clean, 2), true);
  for (const update of [{ PULSE_D15C5I_DISPOSABLE_ONLY: '' }, { NODE_ENV: 'production' },
    { DATABASE_URL: 'postgres://synthetic' }, { PGHOST: 'localhost' },
    { PGPASSWORD: 'synthetic' }, { PULSE_D15C5I_DELIVERY_URL: 'http://127.0.0.1' },
    { PULSE_D15C5I_EXTERNAL_CUSTODY: 'YES' }, { PULSE_D15C5I_APPROVE: 'YES' },
    { PULSE_D15C5I_LIVE_OPERATOR: 'YES' }])
    assert.equal(guardDurableDecisionRehearsal({ ...clean, ...update }, 2), false);
  assert.equal(guardDurableDecisionRehearsal(clean, 3), false);
});
