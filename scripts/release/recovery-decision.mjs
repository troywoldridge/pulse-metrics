// Phase 2E3C5D4 — pure, fail-closed post-interruption interpretation.
// Never performs database I/O and never authorizes unattended retry.
import { MIGRATION_SHA256, planDigest, verifyPlan } from './release-policy.mjs';

export const RECOVERY = Object.freeze({
  APPLIED: 'APPLIED_VERIFIED_DO_NOT_REPLAY',
  ABORTED: 'ABORTED_VERIFIED_REQUIRE_FRESH_APPROVAL',
  QUARANTINE: 'QUARANTINE_MANUAL_INVESTIGATION',
});

/**
 * Evidence is meaningful only when collected under the SAME cooperative
 * release lock, on a freshly verified socket/role/catalog and trusted ledger.
 * A missing receipt is not sufficient evidence to retry on its own.
 */
export function decideRecovery({ plan, lockHeld, baselineVerified, receipt, canary }) {
  const quarantine = RECOVERY.QUARANTINE;
  try {
    verifyPlan(plan);
  } catch {
    return quarantine;
  }
  if (lockHeld !== true || baselineVerified !== true) return quarantine;
  if (receipt === undefined || canary === undefined) return quarantine;
  if (receipt === null && canary === null) return RECOVERY.ABORTED;
  if (receipt === null || canary === null) return quarantine;
  if (typeof receipt !== 'object' || Array.isArray(receipt) ||
      typeof canary !== 'object' || Array.isArray(canary)) return quarantine;
  if (receipt.release_id !== plan.releaseId ||
      receipt.plan_sha256 !== planDigest(plan) ||
      receipt.migration_sha256 !== MIGRATION_SHA256 ||
      !Number.isInteger(receipt.total_receipts) || receipt.total_receipts !== 1 ||
      typeof receipt.operator_subject !== 'string' || !receipt.operator_subject ||
      typeof receipt.reviewer_subject !== 'string' || !receipt.reviewer_subject ||
      receipt.operator_subject === receipt.reviewer_subject ||
      canary.id !== 1 || canary.description !== 'synthetic approved release' ||
      canary.total_canary !== 1) return quarantine;
  return RECOVERY.APPLIED;
}
