/**
 * Pulse Metrics D15C-5G — REVIEW-ONLY recovery evidence and frozen local witness.
 * Purely local disposable files. No database, external HTTP, scheduler, identity,
 * alert transmission, automated replay, production approvals or acknowledgement.
 *
 * The witness is a SECOND LOCAL FILE controlled by this same test user. It
 * detects drift relative to its frozen checkpoint; it is NOT independent
 * external custody, a signature, an immutable ledger or an authentic anchor.
 */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, writeSync } from 'node:fs';
import { verifyAuditJournal } from './maintenance-audit-policy.mjs';
import { isValidLocalAuditReceipt, previewAlertFromAuditReceipt } from './operator-alert-contract.mjs';
import { readPrivateOutbox } from './isolated-alert-handoff.mjs';

const EXACT = (x, keys) => x !== null && typeof x === 'object' &&
  !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype &&
  Object.keys(x).sort().join('|') === [...keys].sort().join('|');
const HEX = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const PATH = /^\/tmp\/pulse-alert-witness-[a-f0-9]{10}$/;
const ANCHOR_KEYS = [
  'schema','auditSequence','auditHead','outboxCount','outboxHash',
  'missingOutbox','createdAt','hash',
];
export const RECOVERY = Object.freeze({
  schema: 'pulse-local-alert-witness/v1',
  marker: '.pulse-alert-witness-marker',
  file: 'frozen-checkpoint.json',
  maxBytes: 1024,
  liveDelivery: false,
  automaticReplay: false,
  humanAcknowledgementVerified: false,
  independentExternalCustody: false,
  productionAuthorized: false,
  publicLaunch: 'NO_GO',
});
function secureFile(path, expectedMode) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
      st.uid !== process.getuid() || (st.mode & 0o777) !== expectedMode)
    throw Error('witness_not_private');
}
export function assertPrivateWitnessDirectory(dir) {
  if (typeof dir !== 'string' || !PATH.test(dir)) throw Error('witness_directory_refused');
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() ||
      (st.mode & 0o777) !== 0o700) throw Error('witness_directory_refused');
  secureFile(`${dir}/${RECOVERY.marker}`, 0o600);
}
function validateAnchor(a) {
  if (!EXACT(a, ANCHOR_KEYS) || a.schema !== RECOVERY.schema ||
      !Number.isSafeInteger(a.auditSequence) || a.auditSequence < 0 ||
      a.auditSequence > 2048 || !HEX.test(a.auditHead) ||
      !Number.isSafeInteger(a.outboxCount) || a.outboxCount < 0 ||
      a.outboxCount > 32 || !HEX.test(a.outboxHash) ||
      !Number.isSafeInteger(a.missingOutbox) || a.missingOutbox < 0 ||
      a.missingOutbox > 2048 || typeof a.createdAt !== 'string' ||
      !ISO.test(a.createdAt) || !Number.isFinite(Date.parse(a.createdAt)) ||
      !HEX.test(a.hash)) throw Error('witness_invalid');
  const { hash, ...body } = a;
  if (sha(JSON.stringify(body)) !== hash) throw Error('witness_invalid');
  return a;
}
export function readFrozenWitness(dir) {
  assertPrivateWitnessDirectory(dir);
  const path = `${dir}/${RECOVERY.file}`;
  secureFile(path, 0o600); // also rejects missing files and dangling symlinks
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() ||
        (st.mode & 0o777) !== 0o600 || st.size < 1 ||
        st.size > RECOVERY.maxBytes) throw Error('witness_invalid');
    source = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw Error('witness_invalid'); }
  // Reject alternate encodings, duplicate JSON keys and trailing bytes.
  // Only our own canonical single-object serializer is accepted.
  if (source !== JSON.stringify(parsed)) throw Error('witness_invalid');
  return validateAnchor(parsed);
}
function inspectSource(auditDir, handoffDir) {
  const journal = verifyAuditJournal(auditDir);
  const outbox = readPrivateOutbox(handoffDir);
  if (!Array.isArray(journal.rows) || !Array.isArray(outbox.records))
    throw Error('recovery_evidence_invalid');
  const wanted = new Map();
  for (const row of journal.rows) {
    if (!isValidLocalAuditReceipt(row)) throw Error('recovery_evidence_invalid');
    const preview = previewAlertFromAuditReceipt(row);
    if (preview.disposition === 'rejected') throw Error('recovery_evidence_invalid');
    if (preview.disposition === 'review_only_not_sent') {
      if (wanted.has(preview.idempotencyKey)) throw Error('recovery_evidence_invalid');
      wanted.set(preview.idempotencyKey, preview);
    }
  }
  const matched = new Set();
  for (const row of outbox.records) {
    const expected = wanted.get(row.key);
    if (!expected || row.auditHash !== expected.auditHash ||
        row.auditSequence !== expected.auditSequence ||
        row.code !== expected.code || row.severity !== expected.severity ||
        matched.has(row.key)) throw Error('recovery_evidence_invalid');
    matched.add(row.key);
  }
  return {
    journal, outbox,
    missingOutbox: wanted.size - matched.size,
    outboxHash: sha(JSON.stringify(outbox)),
  };
}
/**
 * Freeze evidence ONCE, after the caller explicitly locks both local stores.
 * An existing checkpoint, including a dangling symlink, is NEVER replaced.
 * The initial snapshot itself does not establish trustworthy custody.
 */
export function freezeLocalWitness(auditDir, handoffDir, witnessDir) {
  assertPrivateWitnessDirectory(witnessDir);
  const src = inspectSource(auditDir, handoffDir);
  const body = {
    schema: RECOVERY.schema,
    auditSequence: src.journal.sequence,
    auditHead: src.journal.hash,
    outboxCount: src.outbox.records.length,
    outboxHash: src.outboxHash,
    missingOutbox: src.missingOutbox,
    createdAt: new Date().toISOString(),
  };
  const saved = { ...body, hash: sha(JSON.stringify(body)) };
  const bytes = Buffer.from(JSON.stringify(saved));
  if (bytes.length > RECOVERY.maxBytes) throw Error('witness_invalid');
  const name = `${witnessDir}/${RECOVERY.file}`;
  const fd = openSync(name, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let written = false;
  try {
    if (writeSync(fd, bytes) !== bytes.length) throw Error('witness_write_failed');
    fsyncSync(fd);
    written = true;
  } finally { closeSync(fd); }
  if (!written) throw Error('witness_write_failed');
  const dfd = openSync(witnessDir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  const observed = readFrozenWitness(witnessDir);
  if (JSON.stringify(saved) !== JSON.stringify(observed))
    throw Error('witness_write_failed');
  return { frozen: true, reviewOnly: true, externallyAnchored: false };
}
/** A frozen witness prohibits any automatic replay, mutation or re-anchoring. */
export function inspectFrozenRecovery(auditDir, handoffDir, witnessDir) {
  const anchor = readFrozenWitness(witnessDir);
  const src = inspectSource(auditDir, handoffDir);
  if (src.journal.sequence !== anchor.auditSequence ||
      src.journal.hash !== anchor.auditHead ||
      src.outbox.records.length !== anchor.outboxCount ||
      src.outboxHash !== anchor.outboxHash ||
      src.missingOutbox !== anchor.missingOutbox)
    throw Error('recovery_evidence_changed');
  const counts = { pending: 0, inFlight: 0, retryPending: 0,
    transportAccepted: 0, receiverDuplicate: 0, deadLetter: 0,
    missingOutbox: src.missingOutbox };
  for (const r of src.outbox.records) {
    switch (r.status) {
      case 'pending': counts.pending++; break;
      case 'in_flight': counts.inFlight++; break;
      case 'retry_pending': counts.retryPending++; break;
      case 'transport_accepted': counts.transportAccepted++; break;
      case 'receiver_duplicate': counts.receiverDuplicate++; break;
      case 'dead_letter': counts.deadLetter++; break;
      default: throw Error('recovery_evidence_invalid');
    }
  }
  return Object.freeze({
    decision: 'manual_review_required',
    witness: 'frozen_local_only',
    automaticReplayAuthorized: false,
    liveDeliveryAuthorized: false,
    humanAcknowledgementVerified: false,
    independentExternalCustodyVerified: false,
    counts: Object.freeze(counts),
  });
}
/** Guard applied before reading any local private files. No connection APIs. */
export function guardRecoveryRehearsal(env = process.env, argc = process.argv.length) {
  const PG = /^(?:PGPASSWORD|PGPASSFILE|PGHOST|PGHOSTADDR|PGPORT|PGUSER|PGDATABASE|PGSERVICE|PGSERVICEFILE|PGOPTIONS|PGCLUSTER|PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT)$/;
  return argc === 2 && env.PULSE_D15C5G_DISPOSABLE_ONLY === 'YES' &&
    env.NODE_ENV !== 'production' && !env.DATABASE_URL &&
    !env.PULSE_D15C5G_DELIVERY_URL && !env.PULSE_D15C5G_ANCHOR_URL &&
    !env.PULSE_D15C5G_APPROVE_LIVE && !env.PULSE_D15C5G_OPERATOR &&
    !Object.keys(env).some(k => PG.test(k));
}
