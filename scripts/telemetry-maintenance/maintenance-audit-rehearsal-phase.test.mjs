/** Pure unit regression tests for the D15C-5D two-pass rehearsal guard. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRehearsalJournalPhase, expectedRehearsalSequence }
  from './maintenance-audit-rehearsal-phase.mjs';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditRecord, verifyAuditJournal }
  from './maintenance-audit-policy.mjs';

function journal(count) {
  return { sequence: count, rows: Array.from({ length: count }, () => ({})) };
}

test('D15C-5D first invocation requires empty verified journal', () => {
  assert.equal(expectedRehearsalSequence(undefined), 0);
  assert.equal(assertRehearsalJournalPhase(journal(0), undefined), 0);
  assert.throws(() => assertRehearsalJournalPhase(journal(4), undefined),
    /unexpected verified journal sequence/);
});

test('D15C-5D revoked-permission invocation requires four verified receipts', () => {
  assert.equal(expectedRehearsalSequence('YES'), 4);
  assert.equal(assertRehearsalJournalPhase(journal(4), 'YES'), 4);
  for (const n of [0, 3, 5]) {
    assert.throws(() => assertRehearsalJournalPhase(journal(n), 'YES'),
      /unexpected verified journal sequence/);
  }
});

test('D15C-5D invalid phase environment fails closed', () => {
  for (const flag of ['', 'NO', 'yes', 'TRUE', '1']) {
    assert.throws(() => assertRehearsalJournalPhase(journal(0), flag),
      /unexpected rehearsal mode/);
  }
});

test('D15C-5D malformed verified-journal shapes fail closed', () => {
  for (const input of [null, undefined, {}, { sequence: -1, rows: [] },
    { sequence: 0 }, { sequence: 0, rows: [1] },
    { sequence: 4, rows: [] }, { sequence: '4', rows: [{}, {}, {}, {}] }]) {
    assert.throws(() => assertRehearsalJournalPhase(input, 'YES'),
      /unexpected verified journal sequence/);
  }
});

// Exercise the guard against an actual private hash-linked JSONL journal,
// not just a synthetic {sequence, rows} object. No DB or network involved.

test('D15C-5D second pass accepts four real linked receipts but rejects tampering', () => {
  const dir = join(tmpdir(), `pulse-maint-audit-${randomBytes(5).toString('hex')}`);
  mkdirSync(dir, { mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
    writeFileSync(`${dir}/.pulse-maintenance-audit-marker`, 'DISPOSABLE TEST\n',
      { mode: 0o600 });
    assert.equal(assertRehearsalJournalPhase(verifyAuditJournal(dir), undefined), 0);
    const classification = { status: 'overlap_skipped', alertCode: null,
      severity: 'none', batches: 0, networkRemoved: 0, agentRemoved: 0 };
    for (let i = 0; i < 4; i += 1) appendAuditRecord(dir, classification);
    assert.equal(assertRehearsalJournalPhase(verifyAuditJournal(dir), 'YES'), 4);
    const journal = `${dir}/maintenance-audit.jsonl`;
    const source = readFileSync(journal, 'utf8');
    writeFileSync(journal, source.replace('overlap_skipped', 'maintenance_failed'));
    assert.throws(() => verifyAuditJournal(dir), /audit_integrity_failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
