/**
 * Pulse Metrics D15C-5D: disposable-only, LOCAL audit + alert-candidate policy.
 * This does not send alerts, grant database rights, schedule jobs or connect to DB.
 * The only accepted controller protocol is the pinned D15C-5C event format.
 * This journal is locally tamper-EVIDENT, not externally immutable or durable.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
         mkdirSync, openSync, readFileSync, rmdirSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export const AUDIT_POLICY = Object.freeze({
  maxControllerBytes: 16384,
  maxEvents: 10,
  maxJournalBytes: 2097152,
  maxRecords: 2048,
  file: 'maintenance-audit.jsonl',
  directoryPattern: /^\/tmp\/pulse-maint-audit-[A-Za-z0-9]{10}$/,
  marker: '.pulse-maintenance-audit-marker',
});
const MAX_BATCH = 250;
const MAX_BATCHES = 3;
const PREFIX = 'D15C5C_EVENT ';
const HEX = /^[0-9a-f]{64}$/;
const EXACT = (obj, keys) => obj !== null && typeof obj === 'object' &&
  !Array.isArray(obj) && Object.keys(obj).sort().join('|') === [...keys].sort().join('|');
const count = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_BATCH;
function unacceptable() { return {
  status: 'invalid_output', alertCode: 'maintenance_protocol_invalid',
  severity: 'critical', batches: 0, networkRemoved: 0, agentRemoved: 0,
}; }
function classification(status, alertCode, severity, batches=0, networkRemoved=0, agentRemoved=0) {
  return { status, alertCode, severity, batches, networkRemoved, agentRemoved };
}

/** Never include stdout/stderr/error text in returned values or persisted rows. */
export function classifyController({ exitCode, signal = null, stdout, stderr = '' }) {
  try {
    if (!Number.isSafeInteger(exitCode) || ![0,1].includes(exitCode) ||
        signal !== null || typeof stdout !== 'string' ||
        typeof stderr !== 'string' || stderr !== '' ||
        Buffer.byteLength(stdout) > AUDIT_POLICY.maxControllerBytes ||
        !stdout.endsWith('\n')) return unacceptable();
    const lines = stdout.slice(0, -1).split('\n');
    if (lines.length < 1 || lines.length > AUDIT_POLICY.maxEvents) return unacceptable();
    const events = lines.map(line => {
      if (!line.startsWith(PREFIX)) throw Error('bad prefix');
      const raw = line.slice(PREFIX.length);
      if (raw.length > 1024) throw Error('oversized event');
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Error('invalid event');
      return obj;
    });
    const first = events[0];
    if (events.length === 1 && exitCode === 0 &&
        EXACT(first, ['event','alert']) && first.event === 'overlap_skipped' &&
        first.alert === false) {
      return classification('overlap_skipped', null, 'none');
    }
    if (events.length === 1 && exitCode === 1 &&
        EXACT(first, ['event','alert']) && first.event === 'configuration_denied' &&
        first.alert === true) {
      return classification('failed', 'maintenance_configuration_denied', 'critical');
    }
    const last = events.at(-1);
    if (exitCode === 1 && EXACT(last, ['event','reason','alert']) &&
        last.event === 'maintenance_failed' && last.reason === 'operation_unavailable' &&
        last.alert === true && (events.length === 1 ||
        (events.length === 2 && EXACT(first, ['event','alert']) &&
         first.event === 'maintenance_started' && first.alert === false))) {
      return classification('failed', 'maintenance_operation_failed', 'critical');
    }
    if (exitCode !== 0 || events.length < 3 ||
        !EXACT(first, ['event','alert']) || first.event !== 'maintenance_started' ||
        first.alert !== false || !EXACT(last, [
          'event','batches','networkRemoved','agentRemoved','possibleBacklog','alert',
        ]) || last.event !== 'maintenance_completed' ||
        typeof last.possibleBacklog !== 'boolean' ||
        last.alert !== last.possibleBacklog) return unacceptable();
    const batches = events.slice(1, -1);
    if (batches.length > MAX_BATCHES || batches.length < 1 ||
        last.batches !== batches.length) return unacceptable();
    let nTotal = 0, aTotal = 0;
    for (let i = 0; i < batches.length; i += 1) {
      const row = batches[i];
      if (!EXACT(row, ['event','batch','networkRemoved','agentRemoved','alert']) ||
          row.event !== 'batch_completed' || row.batch !== i + 1 ||
          row.alert !== false || !count(row.networkRemoved) ||
          !count(row.agentRemoved)) return unacceptable();
      nTotal += row.networkRemoved;
      aTotal += row.agentRemoved;
      if (i < batches.length - 1 && row.networkRemoved === 0 &&
          row.agentRemoved === 0) return unacceptable();
    }
    const lastBatch = batches.at(-1);
    const backlog = batches.length === MAX_BATCHES &&
      (lastBatch.networkRemoved > 0 || lastBatch.agentRemoved > 0);
    if (last.possibleBacklog !== backlog ||
        last.networkRemoved !== nTotal || last.agentRemoved !== aTotal) return unacceptable();
    return classification('completed', backlog ? 'maintenance_possible_backlog' : null,
      backlog ? 'warning' : 'none', batches.length, nTotal, aTotal);
  } catch { return unacceptable(); }
}

function digest(row) {
  return createHash('sha256').update(JSON.stringify(row), 'utf8').digest('hex');
}
function secureStat(path, expectedMode) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.uid !== process.getuid() || (info.mode & 0o777) !== expectedMode) {
    throw Error('audit_path_rejected');
  }
}
export function assertPrivateAuditDirectory(dir) {
  if (typeof dir !== 'string' || !AUDIT_POLICY.directoryPattern.test(dir) ||
      basename(dir) !== dir.split('/').at(-1)) throw Error('audit_directory_rejected');
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o700) throw Error('audit_directory_rejected');
  secureStat(`${dir}/${AUDIT_POLICY.marker}`, 0o600);
}
function journalPath(dir) { return `${dir}/${AUDIT_POLICY.file}`; }
/** All existing rows are checked before any append or child maintenance process. */
export function verifyAuditJournal(dir) {
  assertPrivateAuditDirectory(dir);
  const name = journalPath(dir);
  if (!existsSync(name)) return { sequence: 0, hash: '0'.repeat(64), rows: [] };
  secureStat(name, 0o600);
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() ||
        (st.mode & 0o777) !== 0o600 || st.size > AUDIT_POLICY.maxJournalBytes) {
      throw Error('audit_integrity_failed');
    }
    source = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  if (!source) return { sequence: 0, hash: '0'.repeat(64), rows: [] };
  if (!source.endsWith('\n')) throw Error('audit_integrity_failed');
  const lines = source.slice(0, -1).split('\n');
  if (lines.length > AUDIT_POLICY.maxRecords) throw Error('audit_integrity_failed');
  let previousHash = '0'.repeat(64);
  const rows = [];
  for (const line of lines) {
    if (Buffer.byteLength(line) > 1500) throw Error('audit_integrity_failed');
    let parsed;
    try { parsed = JSON.parse(line); } catch { throw Error('audit_integrity_failed'); }
    if (!EXACT(parsed, ['schema','sequence','timestamp','runId','status','alertCode',
          'severity','batches','networkRemoved','agentRemoved','previousHash','hash']) ||
        parsed.schema !== 'pulse-maintenance-audit/v1' ||
        parsed.sequence !== rows.length + 1 ||
        typeof parsed.timestamp !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed.timestamp) ||
        typeof parsed.runId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(parsed.runId) ||
        !['completed','overlap_skipped','failed','invalid_output'].includes(parsed.status) ||
        !['none','warning','critical'].includes(parsed.severity) ||
        !(parsed.alertCode === null ||
          ['maintenance_possible_backlog','maintenance_operation_failed',
           'maintenance_configuration_denied','maintenance_protocol_invalid']
           .includes(parsed.alertCode)) ||
        !Number.isSafeInteger(parsed.batches) || parsed.batches < 0 ||
        parsed.batches > MAX_BATCHES ||
        !Number.isSafeInteger(parsed.networkRemoved) || parsed.networkRemoved < 0 ||
        parsed.networkRemoved > 750 ||
        !Number.isSafeInteger(parsed.agentRemoved) || parsed.agentRemoved < 0 ||
        parsed.agentRemoved > 750 ||
        parsed.previousHash !== previousHash || !HEX.test(parsed.hash)) {
      throw Error('audit_integrity_failed');
    }
    const { hash, ...body } = parsed;
    if (digest(body) !== hash) throw Error('audit_integrity_failed');
    previousHash = hash;
    rows.push(parsed);
  }
  return { sequence: rows.length, hash: previousHash, rows };
}

/** Single-process local journal; never claim independent tamper proofing. */
export function appendAuditRecord(dir, classified) {
  const prior = verifyAuditJournal(dir);
  if (prior.sequence >= AUDIT_POLICY.maxRecords) throw Error('audit_capacity_exceeded');
  if (!EXACT(classified, ['status','alertCode','severity','batches','networkRemoved','agentRemoved'])) {
    throw Error('audit_invalid_classification');
  }
  const body = {
    schema: 'pulse-maintenance-audit/v1', sequence: prior.sequence + 1,
    timestamp: new Date().toISOString(), runId: randomUUID(),
    ...classified, previousHash: prior.hash,
  };
  const row = { ...body, hash: digest(body) };
  const bytes = Buffer.from(JSON.stringify(row) + '\n');
  if (bytes.length > 1500) throw Error('audit_capacity_exceeded');
  const path = journalPath(dir);
  let fd;
  try {
    fd = openSync(path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW |
      (prior.sequence === 0 && !existsSync(path) ?
        constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 || stat.size > AUDIT_POLICY.maxJournalBytes) {
      throw Error('audit_path_rejected');
    }
    if (writeSync(fd, bytes) !== bytes.length) throw Error('audit_write_incomplete');
    fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
  // Fail closed if storage is corrupted or replacement occurred mid-write.
  const checked = verifyAuditJournal(dir);
  if (checked.sequence !== row.sequence || checked.hash !== row.hash) {
    throw Error('audit_integrity_failed');
  }
  return row;
}

/**
 * Serializes every disposable invocation through local audit append. A crash
 * leaves a stale lock and requires manual review; never silently steal it.
 */
export function acquireAuditJournalLock(dir) {
  assertPrivateAuditDirectory(dir);
  const path = `${dir}/.maintenance-audit-run-lock`;
  try { mkdirSync(path, {mode:0o700}); }
  catch { throw Error('audit_run_already_locked'); }
  let released = false;
  return () => {
    if (released) throw Error('audit_unlock_failed');
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
      throw Error('audit_unlock_failed');
    }
    rmdirSync(path);
    released = true;
  };
}
