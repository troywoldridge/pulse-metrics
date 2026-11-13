/**
 * D15C-5D disposable rehearsal phase guard. PURE: no I/O or DB access.
 *
 * The first integration invocation starts with an empty private journal.
 * After the first invocation records four verified outcomes, the disposable
 * launcher revokes only the test maintainer's EXECUTE privilege and invokes
 * the same integration file a second time. That second pass must start from
 * exactly four journal records, not zero.
 *
 * This is test-only state validation. It is NOT an operator permission,
 * production runner mode, maintenance schedule, or audit bypass.
 */
export function expectedRehearsalSequence(flag) {
  if (flag === undefined) return 0;
  if (flag === 'YES') return 4;
  throw new Error('REFUSE_D15C5D_PHASE: unexpected rehearsal mode');
}

/** Require that a *separately verified* journal has exactly the expected count. */
export function assertRehearsalJournalPhase(verifiedJournal, flag) {
  const expected = expectedRehearsalSequence(flag);
  if (!verifiedJournal || !Number.isSafeInteger(verifiedJournal.sequence) ||
      verifiedJournal.sequence !== expected ||
      !Array.isArray(verifiedJournal.rows) ||
      verifiedJournal.rows.length !== expected) {
    throw new Error('REFUSE_D15C5D_PHASE: unexpected verified journal sequence');
  }
  return expected;
}
