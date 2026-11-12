import test from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATION_SHA256, reviewedPlan, planDigest } from './release-policy.mjs';
import { decideRecovery, RECOVERY } from './recovery-decision.mjs';

const plan = reviewedPlan();
const receipt = Object.freeze({
  release_id: plan.releaseId,
  plan_sha256: planDigest(plan),
  migration_sha256: MIGRATION_SHA256,
  total_receipts: 1,
  operator_subject: 'synthetic-operator',
  reviewer_subject: 'synthetic-reviewer',
});
const canary = Object.freeze({ id: 1, description: 'synthetic approved release', total_canary: 1 });
const verify = (rest = {}) => decideRecovery({ plan, lockHeld: true, baselineVerified: true, receipt, canary, ...rest });

test('verified committed receipt and canary must never be re-executed', () => {
  assert.equal(verify(), RECOVERY.APPLIED);
});
test('verified complete absence is not automatic permission to retry', () => {
  assert.equal(verify({ receipt: null, canary: null }), RECOVERY.ABORTED);
});
test('cannot decide without acquiring the cooperative release lock', () => {
  assert.equal(verify({ lockHeld: false }), RECOVERY.QUARANTINE);
});
test('cannot decide without the pinned baseline verification', () => {
  assert.equal(verify({ baselineVerified: false }), RECOVERY.QUARANTINE);
});
test('database outage or unknown evidence quarantines', () => {
  assert.equal(verify({ receipt: undefined }), RECOVERY.QUARANTINE);
  assert.equal(verify({ canary: undefined }), RECOVERY.QUARANTINE);
});
test('receipt without DDL quarantines', () => {
  assert.equal(verify({ canary: null }), RECOVERY.QUARANTINE);
});
test('DDL without a receipt quarantines', () => {
  assert.equal(verify({ receipt: null }), RECOVERY.QUARANTINE);
});
test('foreign release ID or plan digest quarantines', () => {
  assert.equal(verify({ receipt: { ...receipt, release_id: 'unrecognized' } }), RECOVERY.QUARANTINE);
  assert.equal(verify({ receipt: { ...receipt, plan_sha256: 'f'.repeat(64) } }), RECOVERY.QUARANTINE);
});
test('unexpected migration hash quarantines', () => {
  assert.equal(verify({ receipt: { ...receipt, migration_sha256: 'f'.repeat(64) } }), RECOVERY.QUARANTINE);
});
test('duplicate receipt rows quarantine', () => {
  assert.equal(verify({ receipt: { ...receipt, total_receipts: 2 } }), RECOVERY.QUARANTINE);
});
test('duplicate or modified canary rows quarantine', () => {
  assert.equal(verify({ canary: { ...canary, total_canary: 2 } }), RECOVERY.QUARANTINE);
  assert.equal(verify({ canary: { ...canary, description: 'edited' } }), RECOVERY.QUARANTINE);
});
test('same approver subject in durable receipt quarantines', () => {
  assert.equal(verify({ receipt: { ...receipt, reviewer_subject: receipt.operator_subject } }), RECOVERY.QUARANTINE);
});
test('unreviewed release plan quarantines', () => {
  assert.equal(verify({ plan: { ...plan, releaseId: 'different' } }), RECOVERY.QUARANTINE);
});
test('non-boolean lock/baseline evidence quarantines', () => {
  assert.equal(verify({ lockHeld: 'true' }), RECOVERY.QUARANTINE);
  assert.equal(verify({ baselineVerified: 'true' }), RECOVERY.QUARANTINE);
});
