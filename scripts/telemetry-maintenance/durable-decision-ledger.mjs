/**
 * Pulse Metrics D15C-5I: SYNTHETIC, DISPOSABLE ONLY.
 * Persist and witness a *non-authorizing* operator decision. No actual identity,
 * production PostgreSQL, remote custody, alert delivery, scheduler, or replay.
 * Test-only Ed25519 keys and directories are not operational trust anchors.
 */
import { createHash, sign, verify } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, rmdirSync, writeSync,
} from 'node:fs';
import { verifyDecisionAgainstFrozenOutbox } from './custody-ack-contract.mjs';

const HEX = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const LEDGER_PATH = /^\/tmp\/pulse-decision-ledger-[a-f0-9]{10}$/;
const CUSTODY_PATH = /^\/tmp\/pulse-custody-snapshot-[a-f0-9]{10}$/;
const ZERO = '0'.repeat(64);
const hash = v => createHash('sha256').update(v, 'utf8').digest('hex');
const exact = (o, keys) => o !== null && typeof o === 'object' &&
  !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype &&
  Object.keys(o).sort().join('|') === [...keys].sort().join('|');
const validTime = value => typeof value === 'string' && ISO.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keyOk = (key, type) => key?.type === type && key?.asymmetricKeyType === 'ed25519';
const keyId = key => hash(key.export({ format: 'der', type: 'spki' }));
const rowKeys = ['schema', 'sequence', 'keyId', 'nonce', 'alertKey',
  'decisionHash', 'attestationHash', 'outboxHash', 'recordedAt', 'previousHash', 'hash'];
const checkpointKeys = ['schema', 'issuer', 'keyId', 'ledgerHead',
  'ledgerSequence', 'decisionHash', 'issuedAt', 'nonce', 'signature'];

export const DURABLE_DECISION = Object.freeze({
  ledgerSchema: 'pulse-synthetic-durable-decision/v1',
  checkpointSchema: 'pulse-synthetic-replay-checkpoint/v1',
  checkpointIssuer: 'disposable_separate_custodian',
  ledgerMarker: '.pulse-decision-ledger-marker',
  custodyMarker: '.pulse-custody-snapshot-marker',
  ledgerFile: 'synthetic-decisions.jsonl',
  checkpointFile: 'frozen-replay-checkpoint.json',
  maxRecords: 32,
  maxLedgerBytes: 32768,
  maxCheckpointBytes: 1024,
  independentExternalCustody: false,
  realHumanAcknowledgement: false,
  automaticReplayAuthorized: false,
  productionAuthorized: false,
  publicLaunch: 'NO_GO',
});

function statOwnerFile(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
      st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600)
    throw Error('synthetic_private_file_refused');
}
function assertPrivateDir(dir, pattern, marker) {
  if (typeof dir !== 'string' || !pattern.test(dir))
    throw Error('synthetic_private_directory_refused');
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() ||
      st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700)
    throw Error('synthetic_private_directory_refused');
  statOwnerFile(`${dir}/${marker}`);
}
export function assertPrivateDecisionLedger(dir) {
  assertPrivateDir(dir, LEDGER_PATH, DURABLE_DECISION.ledgerMarker);
}
export function assertPrivateCustodySnapshot(dir) {
  assertPrivateDir(dir, CUSTODY_PATH, DURABLE_DECISION.custodyMarker);
}
function hasPath(path) {
  try { lstatSync(path); return true; }
  catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
}
function readExactPrivate(path, max, mayBeAbsent = false) {
  if (!hasPath(path)) {
    if (mayBeAbsent) return null;
    throw Error('synthetic_evidence_missing');
  }
  statOwnerFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() ||
        (st.mode & 0o777) !== 0o600 || st.size < 1 || st.size > max)
      throw Error('synthetic_evidence_invalid');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function fsyncDir(dir) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function validateRow(row, expectedSeq, priorHash, seen, seenAlerts) {
  if (!exact(row, rowKeys) || row.schema !== DURABLE_DECISION.ledgerSchema ||
      row.sequence !== expectedSeq || !HEX.test(row.keyId) ||
      !NONCE.test(row.nonce) || !HEX.test(row.alertKey) ||
      !HEX.test(row.decisionHash) || !HEX.test(row.attestationHash) ||
      !HEX.test(row.outboxHash) || !validTime(row.recordedAt) ||
      row.previousHash !== priorHash || !HEX.test(row.hash) ||
      seen.has(`${row.keyId}:${row.nonce}`) || seenAlerts.has(row.alertKey))
    throw Error('synthetic_ledger_invalid');
  const { hash: recordedHash, ...body } = row;
  if (hash(JSON.stringify(body)) !== recordedHash)
    throw Error('synthetic_ledger_invalid');
  seen.add(`${row.keyId}:${row.nonce}`);
  seenAlerts.add(row.alertKey);
}
/** Re-reads the full canonical SHA-linked ledger, refusing torn or altered writes. */
export function readSyntheticLedger(dir) {
  assertPrivateDecisionLedger(dir);
  const source = readExactPrivate(`${dir}/${DURABLE_DECISION.ledgerFile}`,
    DURABLE_DECISION.maxLedgerBytes, true);
  if (source === null) return { sequence: 0, head: ZERO, rows: [] };
  if (!source.endsWith('\n')) throw Error('synthetic_ledger_invalid');
  const lines = source.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.length > DURABLE_DECISION.maxRecords)
    throw Error('synthetic_ledger_invalid');
  const rows = []; const seen = new Set(); const seenAlerts = new Set();
  let previousHash = ZERO;
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > 1024) throw Error('synthetic_ledger_invalid');
    let row;
    try { row = JSON.parse(line); } catch { throw Error('synthetic_ledger_invalid'); }
    if (JSON.stringify(row) !== line) throw Error('synthetic_ledger_invalid');
    validateRow(row, rows.length + 1, previousHash, seen, seenAlerts);
    rows.push(row); previousHash = row.hash;
  }
  return { sequence: rows.length, head: previousHash, rows };
}
function withLock(dir, callback) {
  assertPrivateDecisionLedger(dir);
  const lock = `${dir}/.synthetic-ledger-writer-lock`;
  mkdirSync(lock, { mode: 0o700 }); // stale lock MUST be investigated; never stolen.
  let result; let failed;
  try { result = callback(); } catch (error) { failed = error; }
  try {
    const st = lstatSync(lock);
    if (!st.isDirectory() || st.isSymbolicLink() ||
        st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700)
      throw Error('synthetic_lock_invalid');
    rmdirSync(lock);
  } catch { throw Error('synthetic_lock_release_failed'); }
  if (failed) throw failed;
  return result;
}
/**
 * A valid SYNTHETIC signature is never a live authorization. The caller must
 * separately validate the original 5D journal, 5F outbox and 5G witness.
 */
export function recordSyntheticDecision({ dir, decision, attestation, witness,
  trustedCustodianKey, frozenOutbox, alert, trustedOperatorKey, now = Date.now() }) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(now))
    throw Error('synthetic_decision_refused');
  return withLock(dir, () => {
    const current = readSyntheticLedger(dir);
    if (current.sequence >= DURABLE_DECISION.maxRecords ||
        current.rows.some(r => r.keyId === decision?.keyId && r.nonce === decision?.nonce) ||
        current.rows.some(r => r.alertKey === decision?.alertKey))
      throw Error('synthetic_decision_refused');
    const result = verifyDecisionAgainstFrozenOutbox(decision, attestation,
      witness, trustedCustodianKey, frozenOutbox, alert, trustedOperatorKey,
      new Set(), now);
    if (result.accepted !== true || !HEX.test(witness.outboxHash))
      throw Error('synthetic_decision_refused');
    const body = {
      schema: DURABLE_DECISION.ledgerSchema,
      sequence: current.sequence + 1,
      keyId: decision.keyId,
      nonce: decision.nonce,
      alertKey: decision.alertKey,
      decisionHash: hash(JSON.stringify(decision)),
      attestationHash: decision.attestationHash,
      outboxHash: witness.outboxHash,
      recordedAt: new Date(now).toISOString(),
      previousHash: current.head,
    };
    const row = { ...body, hash: hash(JSON.stringify(body)) };
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
    if (bytes.length > 1024) throw Error('synthetic_decision_refused');
    const path = `${dir}/${DURABLE_DECISION.ledgerFile}`;
    const fd = current.sequence === 0 && !hasPath(path) ?
      openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        constants.O_NOFOLLOW | constants.O_APPEND, 0o600) :
      openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 ||
          (st.mode & 0o777) !== 0o600 || st.size > DURABLE_DECISION.maxLedgerBytes)
        throw Error('synthetic_ledger_invalid');
      if (writeSync(fd, bytes) !== bytes.length) throw Error('synthetic_write_incomplete');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    fsyncDir(dir);
    const checked = readSyntheticLedger(dir);
    if (checked.sequence !== row.sequence || checked.head !== row.hash)
      throw Error('synthetic_ledger_invalid');
    return Object.freeze({ recorded: true, sequence: row.sequence, head: row.hash,
      reviewOnly: true, productionAuthorized: false,
      automaticReplayAuthorized: false, realHumanAcknowledgement: false });
  });
}

function checkpointBody(ledger, publicKey, nonce, now) {
  return {
    schema: DURABLE_DECISION.checkpointSchema,
    issuer: DURABLE_DECISION.checkpointIssuer,
    keyId: keyId(publicKey),
    ledgerHead: ledger.head,
    ledgerSequence: ledger.sequence,
    decisionHash: ledger.rows.at(-1).decisionHash,
    issuedAt: new Date(now).toISOString(), nonce,
  };
}
function validateCheckpoint(checkpoint, key, ledger, now) {
  if (!exact(checkpoint, checkpointKeys) || !keyOk(key, 'public') ||
      checkpoint.schema !== DURABLE_DECISION.checkpointSchema ||
      checkpoint.issuer !== DURABLE_DECISION.checkpointIssuer ||
      checkpoint.keyId !== keyId(key) ||
      checkpoint.ledgerHead !== ledger.head ||
      checkpoint.ledgerSequence !== ledger.sequence ||
      checkpoint.decisionHash !== ledger.rows.at(-1)?.decisionHash ||
      !HEX.test(checkpoint.ledgerHead) || !HEX.test(checkpoint.decisionHash) ||
      !NONCE.test(checkpoint.nonce) || !SIG.test(checkpoint.signature) ||
      !validTime(checkpoint.issuedAt) ||
      Date.parse(checkpoint.issuedAt) > now + 30000 ||
      now - Date.parse(checkpoint.issuedAt) > 7 * 86400000)
    throw Error('synthetic_checkpoint_invalid');
  const { signature, ...body } = checkpoint;
  const sig = Buffer.from(signature, 'base64url');
  if (sig.length !== 64 || sig.toString('base64url') !== signature ||
      !verify(null, Buffer.from(JSON.stringify(body)), key, sig))
    throw Error('synthetic_checkpoint_invalid');
}
/** Freeze a separately signed *LOCAL* checkpoint, exactly once. */
export function freezeSyntheticCustodyCheckpoint(ledgerDir, custodyDir,
  signingPrivateKey, trustedPublicKey, nonce, now = Date.now()) {
  assertPrivateCustodySnapshot(custodyDir);
  if (!keyOk(signingPrivateKey, 'private') || !keyOk(trustedPublicKey, 'public') ||
      !NONCE.test(nonce) || !Number.isSafeInteger(now))
    throw Error('synthetic_checkpoint_refused');
  const ledger = readSyntheticLedger(ledgerDir);
  if (ledger.sequence === 0) throw Error('synthetic_checkpoint_refused');
  const body = checkpointBody(ledger, trustedPublicKey, nonce, now);
  const checkpoint = { ...body, signature: sign(null,
    Buffer.from(JSON.stringify(body)), signingPrivateKey).toString('base64url') };
  validateCheckpoint(checkpoint, trustedPublicKey, ledger, now);
  const path = `${custodyDir}/${DURABLE_DECISION.checkpointFile}`;
  const bytes = Buffer.from(JSON.stringify(checkpoint));
  if (bytes.length > DURABLE_DECISION.maxCheckpointBytes)
    throw Error('synthetic_checkpoint_refused');
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    if (writeSync(fd, bytes) !== bytes.length) throw Error('synthetic_checkpoint_write_failed');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDir(custodyDir);
  verifySyntheticCustodyCheckpoint(ledgerDir, custodyDir, trustedPublicKey, now);
  return Object.freeze({ frozen: true, locallySigned: true, externalCustody: false,
    productionAuthorized: false });
}
/** Verify after restart using only a pinned public key, never an embedded key. */
export function verifySyntheticCustodyCheckpoint(ledgerDir, custodyDir,
  trustedPublicKey, now = Date.now()) {
  assertPrivateCustodySnapshot(custodyDir);
  if (!Number.isSafeInteger(now) || !keyOk(trustedPublicKey, 'public'))
    throw Error('synthetic_checkpoint_refused');
  const ledger = readSyntheticLedger(ledgerDir);
  if (ledger.sequence === 0) throw Error('synthetic_checkpoint_invalid');
  const source = readExactPrivate(`${custodyDir}/${DURABLE_DECISION.checkpointFile}`,
    DURABLE_DECISION.maxCheckpointBytes);
  let checkpoint;
  try { checkpoint = JSON.parse(source); }
  catch { throw Error('synthetic_checkpoint_invalid'); }
  if (JSON.stringify(checkpoint) !== source)
    throw Error('synthetic_checkpoint_invalid');
  validateCheckpoint(checkpoint, trustedPublicKey, ledger, now);
  return Object.freeze({ verified: true, sequence: ledger.sequence,
    manualReviewRequired: true, automaticReplayAuthorized: false,
    realHumanAcknowledgement: false, externalCustodyVerified: false });
}

/** Refuse unsafe execution context before opening any private file or socket. */
export function guardDurableDecisionRehearsal(env = process.env, argc = process.argv.length) {
  const PG = /^(?:PGPASSWORD|PGPASSFILE|PGHOST|PGHOSTADDR|PGPORT|PGUSER|PGDATABASE|PGSERVICE|PGSERVICEFILE|PGOPTIONS|PGCLUSTER|PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT)$/;
  return argc === 2 && env.PULSE_D15C5I_DISPOSABLE_ONLY === 'YES' &&
    env.NODE_ENV !== 'production' && !env.DATABASE_URL &&
    !env.PULSE_D15C5I_DELIVERY_URL && !env.PULSE_D15C5I_EXTERNAL_CUSTODY &&
    !env.PULSE_D15C5I_LIVE_OPERATOR && !env.PULSE_D15C5I_APPROVE &&
    !Object.keys(env).some(k => PG.test(k));
}
