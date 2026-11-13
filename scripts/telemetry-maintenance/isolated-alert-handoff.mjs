/**
 * Pulse Metrics D15C-5F — DISPOSABLE-ONLY local alert handoff.
 * NOT a production transport, identity system, or scheduler.
 * Only a caller-created loopback fake receiver is supported. No URL strings,
 * webhook destinations, cloud services, credentials, or database connections.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync,
  openSync, readFileSync, renameSync, unlinkSync, writeSync,
  mkdirSync, rmdirSync } from 'node:fs';
import { request } from 'node:http';
import { previewAlertFromAuditReceipt, reviewOperatorProposal } from './operator-alert-contract.mjs';

const HEX = /^[0-9a-f]{64}$/;
const EXACT = (x, keys) => x !== null && typeof x === 'object' &&
  !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype &&
  Object.keys(x).sort().join('|') === [...keys].sort().join('|');
export const HANDOFF = Object.freeze({
  schema: 'pulse-local-alert-handoff/v1',
  envelopeSchema: 'pulse-local-alert-envelope/v1',
  maxAttempts: 3, maxOutboxBytes: 65536,
  directoryPattern: /^\/tmp\/pulse-alert-handoff-[a-f0-9]{10}$/,
  marker: '.pulse-alert-handoff-marker', file: 'outbox.json',
  endpoint: '/pulse-disposable-alert-test',
  liveDelivery: false, operatorAuthorized: false, publicLaunch: 'NO_GO',
});
const STATES = new Set(['pending', 'in_flight', 'retry_pending',
  'transport_accepted', 'receiver_duplicate', 'dead_letter']);
const CODES = new Set(['maintenance_possible_backlog',
  'maintenance_operation_failed', 'maintenance_configuration_denied',
  'maintenance_protocol_invalid']);
const pathExistsWithoutFollowingLinks = path => {
  try { lstatSync(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
};
const statPrivate = (path, mode) => {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
      st.uid !== process.getuid() || (st.mode & 0o777) !== mode)
    throw Error('private_file_rejected');
};
export function assertPrivateHandoffDirectory(dir) {
  if (typeof dir !== 'string' || !HANDOFF.directoryPattern.test(dir))
    throw Error('handoff_directory_rejected');
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() ||
      (st.mode & 0o777) !== 0o700) throw Error('handoff_directory_rejected');
  statPrivate(`${dir}/${HANDOFF.marker}`, 0o600);
}
function validateRecord(r) {
  if (!EXACT(r, ['key','auditHash','auditSequence','code','severity',
    'status','attempts','lastOutcome']) || !HEX.test(r.key) ||
      !HEX.test(r.auditHash) || !Number.isSafeInteger(r.auditSequence) ||
      r.auditSequence < 1 || r.auditSequence > 2048 || !CODES.has(r.code) ||
      r.severity !== (r.code === 'maintenance_possible_backlog' ? 'warning' : 'critical') ||
      !STATES.has(r.status) || !Number.isSafeInteger(r.attempts) ||
      r.attempts < 0 || r.attempts > HANDOFF.maxAttempts ||
      ![null,'retryable','transport_accepted','receiver_duplicate','permanent_failure',
        'protocol_invalid'].includes(r.lastOutcome)) throw Error('outbox_invalid');
  if ((r.status === 'pending' && (r.attempts !== 0 || r.lastOutcome !== null)) ||
      (r.status !== 'pending' && r.attempts === 0) ||
      (r.status === 'in_flight' && r.lastOutcome !== null) ||
      (r.status === 'retry_pending' && (r.lastOutcome !== 'retryable' ||
        r.attempts >= HANDOFF.maxAttempts)) ||
      (r.status === 'transport_accepted' && r.lastOutcome !== 'transport_accepted') ||
      (r.status === 'receiver_duplicate' && r.lastOutcome !== 'receiver_duplicate') ||
      (r.status === 'dead_letter' && !['retryable','permanent_failure',
        'protocol_invalid'].includes(r.lastOutcome))) throw Error('outbox_invalid');
}
export function readPrivateOutbox(dir) {
  assertPrivateHandoffDirectory(dir);
  const path = `${dir}/${HANDOFF.file}`;
  if (!pathExistsWithoutFollowingLinks(path)) return { schema: HANDOFF.schema, records: [] };
  statPrivate(path, 0o600);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() ||
        (st.mode & 0o777) !== 0o600 || st.size > HANDOFF.maxOutboxBytes)
      throw Error('outbox_invalid');
    source = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  let data;
  try { data = JSON.parse(source); } catch { throw Error('outbox_invalid'); }
  if (!EXACT(data, ['schema','records']) || data.schema !== HANDOFF.schema ||
      !Array.isArray(data.records) || data.records.length > 32)
    throw Error('outbox_invalid');
  const keys = new Set();
  for (const r of data.records) {
    validateRecord(r);
    if (keys.has(r.key)) throw Error('outbox_invalid');
    keys.add(r.key);
  }
  return data;
}

/** Atomic local-file replacement. Only this test run holds the directory lock. */
function store(dir, data) {
  assertPrivateHandoffDirectory(dir);
  const name = `${dir}/${HANDOFF.file}`;
  if (pathExistsWithoutFollowingLinks(name)) statPrivate(name, 0o600);
  const bytes = Buffer.from(JSON.stringify(data));
  if (bytes.length > HANDOFF.maxOutboxBytes) throw Error('outbox_full');
  // Fixed scratch file; reject a stale scratch file rather than overwriting it.
  const temp = `${dir}/.outbox.pending`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let complete = false;
  try {
    if (writeSync(fd, bytes) !== bytes.length) throw Error('outbox_write_failed');
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) { try { unlinkSync(temp); } catch {} }
  }
  renameSync(temp, name);
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  // Never claim success if persisted state cannot be re-read and validated.
  const observed = readPrivateOutbox(dir);
  if (JSON.stringify(observed) !== JSON.stringify(data)) throw Error('outbox_write_failed');
}
export function acquireHandoffLock(dir) {
  assertPrivateHandoffDirectory(dir);
  const path = `${dir}/.handoff-run-lock`;
  // All filesystem operations remain synchronous. This is a non-stealable
  // LOCAL TEST lock; on a crash, a human must inspect and remove test files.
  mkdirSync(path, { mode: 0o700 });
  let released = false;
  return () => {
    if (released) throw Error('handoff_unlock_invalid');
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() ||
        (st.mode & 0o777) !== 0o700) throw Error('handoff_unlock_invalid');
    rmdirSync(path); released = true;
  };
}

export function queueAuditReceipt(dir, receipt) {
  // Fail closed for a non-alert or malformed receipt; never generate an alert
  // from a loosely shaped, unverified 5D record.
  const preview = previewAlertFromAuditReceipt(receipt);
  if (preview.disposition !== 'review_only_not_sent')
    throw Error('alert_receipt_not_eligible');
  const data = readPrivateOutbox(dir);
  const existing = data.records.find(r => r.key === preview.idempotencyKey);
  if (existing) {
    if (existing.auditHash !== preview.auditHash ||
        existing.auditSequence !== preview.auditSequence ||
        existing.code !== preview.code || existing.severity !== preview.severity)
      throw Error('outbox_conflict');
    return { ...existing };
  }
  if (data.records.length >= 32) throw Error('outbox_full');
  const record = {
    key: preview.idempotencyKey, auditHash: preview.auditHash,
    auditSequence: preview.auditSequence, code: preview.code,
    severity: preview.severity, status: 'pending', attempts: 0, lastOutcome: null,
  };
  data.records.push(record);
  store(dir, data);
  return { ...record };
}
export function beginLocalAttempt(dir, key) {
  const data = readPrivateOutbox(dir);
  const row = data.records.find(r => r.key === key);
  if (!row || !['pending', 'retry_pending'].includes(row.status) ||
      row.attempts >= HANDOFF.maxAttempts) throw Error('attempt_refused');
  row.attempts += 1;
  row.status = 'in_flight';
  row.lastOutcome = null;
  store(dir, data); // DURABLE BEFORE ANY TEST SEND
  return { ...row };
}
export function finishLocalAttempt(dir, key, attempt, result) {
  if (!['retryable','transport_accepted','receiver_duplicate','permanent_failure',
    'protocol_invalid'].includes(result)) throw Error('outcome_refused');
  const data = readPrivateOutbox(dir);
  const row = data.records.find(r => r.key === key);
  if (!row || row.status !== 'in_flight' || row.attempts !== attempt)
    throw Error('outcome_refused');
  row.lastOutcome = result;
  row.status = result === 'retryable' ?
    (row.attempts >= HANDOFF.maxAttempts ? 'dead_letter' : 'retry_pending') :
    result === 'transport_accepted' ? 'transport_accepted' :
    result === 'receiver_duplicate' ? 'receiver_duplicate' : 'dead_letter';
  store(dir, data);
  return { ...row };
}

function isEnvelope(body) {
  return EXACT(body, ['schema','key','auditHash','auditSequence','code',
    'severity','attempt','issuedAt']) && body.schema === HANDOFF.envelopeSchema &&
    HEX.test(body.key) && HEX.test(body.auditHash) &&
    Number.isSafeInteger(body.auditSequence) && body.auditSequence >= 1 &&
    body.auditSequence <= 2048 && CODES.has(body.code) &&
    body.severity === (body.code === 'maintenance_possible_backlog' ? 'warning' : 'critical') &&
    Number.isSafeInteger(body.attempt) && body.attempt >= 1 &&
    body.attempt <= HANDOFF.maxAttempts && typeof body.issuedAt === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.issuedAt) &&
    Number.isFinite(Date.parse(body.issuedAt));
}
function secretOk(secret) { return Buffer.isBuffer(secret) && secret.length === 32; }
export function makeSignedLocalEnvelope(row, secret, now = new Date()) {
  if (!secretOk(secret) || !Number.isFinite(now?.getTime?.()) ||
      !EXACT(row, ['key','auditHash','auditSequence','code','severity',
        'status','attempts','lastOutcome']) || row.status !== 'in_flight')
    throw Error('local_signature_refused');
  validateRecord(row);
  const body = { schema: HANDOFF.envelopeSchema, key: row.key,
    auditHash: row.auditHash, auditSequence: row.auditSequence,
    code: row.code, severity: row.severity, attempt: row.attempts,
    issuedAt: now.toISOString() };
  if (!isEnvelope(body)) throw Error('local_signature_refused');
  const signature = createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  return { ...body, signature };
}
export function verifySignedLocalEnvelope(envelope, secret, expected, now = Date.now()) {
  if (!secretOk(secret) || !EXACT(envelope, ['schema','key','auditHash',
    'auditSequence','code','severity','attempt','issuedAt','signature']) ||
      !Number.isFinite(now) || !HEX.test(envelope.signature)) return false;
  const { signature, ...body } = envelope;
  if (!isEnvelope(body) || Math.abs(Date.parse(body.issuedAt) - now) > 30000 ||
      !EXACT(expected, ['key','auditHash','auditSequence','code','severity']) ||
      ['key','auditHash','auditSequence','code','severity'].some(k => body[k] !== expected[k]))
    return false;
  const actual = createHmac('sha256', secret).update(JSON.stringify(body)).digest();
  const provided = Buffer.from(signature, 'hex');
  return provided.length === actual.length && timingSafeEqual(provided, actual);
}

/** Only loopback fake sink, no DNS, env URLs, proxies or redirects. */
export function sendToLoopbackTestSink(port, envelope) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
      !EXACT(envelope, ['schema','key','auditHash','auditSequence','code',
      'severity','attempt','issuedAt','signature']) || !HEX.test(envelope.signature) ||
      !isEnvelope((({signature, ...body}) => body)(envelope)))
    return Promise.reject(Error('disposable_transport_refused'));
  const payload = Buffer.from(JSON.stringify(envelope));
  if (payload.length > 1536) return Promise.reject(Error('disposable_transport_refused'));
  return new Promise((resolve, reject) => {
    const req = request({ hostname:'127.0.0.1', family:4, port,
      path: HANDOFF.endpoint, method:'POST', agent:false, timeout:1500,
      headers: { 'content-type':'application/json', 'content-length': payload.length,
        'cache-control':'no-store' },
    }, res => {
      let n = 0;
      res.on('data', chunk => { n += chunk.length; if (n > 256) req.destroy(); });
      res.on('end', () => resolve(classifyLoopbackResult(res.statusCode)));
    });
    req.on('timeout', () => req.destroy(Error('disposable_timeout')));
    req.on('error', () => reject(Error('disposable_transport_unavailable')));
    req.end(payload);
  });
}
export function classifyLoopbackResult(statusCode) {
  if (statusCode === 202) return 'transport_accepted'; // NEVER human acknowledgement
  if (statusCode === 409) return 'receiver_duplicate';
  if (statusCode === 503 || statusCode === 429) return 'retryable';
  if ([400,401,403,410].includes(statusCode)) return 'permanent_failure';
  return 'protocol_invalid';
}
export function verifyReviewOnlyOperator(proposal) {
  const r = reviewOperatorProposal(proposal);
  return { reviewDecision:r.decision, productionAuthorized:false,
    realOperatorAuthenticated:false };
}
export function guardIsolatedRehearsal(env = process.env, argc = process.argv.length) {
  const PG = /^(?:PGPASSWORD|PGPASSFILE|PGHOST|PGHOSTADDR|PGPORT|PGUSER|PGDATABASE|PGSERVICE|PGSERVICEFILE|PGOPTIONS|PGCLUSTER|PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT)$/;
  return argc === 2 && env.PULSE_D15C5F_DISPOSABLE_ONLY === 'YES' &&
    env.NODE_ENV !== 'production' && !env.DATABASE_URL &&
    !env.PULSE_D15C5F_DELIVERY_URL && !env.PULSE_D15C5F_LIVE_OPERATOR &&
    !Object.keys(env).some(k => PG.test(k));
}
