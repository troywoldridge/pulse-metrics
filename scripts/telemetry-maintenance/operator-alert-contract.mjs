/**
 * Pulse Metrics D15C-5E: OFFLINE DESIGN CONTRACT ONLY.
 * No database driver, socket, HTTP, scheduler, identity provisioning or alert send.
 * This module never authorizes a live operation: even valid proposals require
 * independent external review, provisioning and security evidence.
 */
import { createHash } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exact = (v, keys) => v !== null && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');

export const CONTRACT = Object.freeze({
  schema: 'pulse-maintenance-ops-review/v1',
  auditSchema: 'pulse-maintenance-audit/v1',
  proposedRole: 'pulse_metrics_maintenance_runner',
  maximumCredentialMinutes: 60,
  maximumReviewRetries: 3,
  publicLaunch: 'NO_GO',
  liveDelivery: false,
  productionAuthorization: false,
});

const PROPOSAL_KEYS = [
  'schema','principalType','databaseRole','credentialSource','credentialMinutes',
  'networkBoundary','allowedActions','directDelete','ownerRoleMembership',
  'applicationRoleMembership','approvalProof','auditCustody','alertDelivery',
  'deploymentEnabled',
];

/**
 * Evaluates a PROPOSED operator profile; this is NOT identity verification.
 * A passing proposal cannot be used to activate service or issue credentials.
 */
export function reviewOperatorProposal(proposal) {
  if (!exact(proposal, PROPOSAL_KEYS) ||
      proposal.schema !== CONTRACT.schema ||
      proposal.principalType !== 'dedicated_nonhuman' ||
      proposal.databaseRole !== CONTRACT.proposedRole ||
      proposal.credentialSource !== 'workload_identity_proposed' ||
      !Number.isSafeInteger(proposal.credentialMinutes) ||
      proposal.credentialMinutes < 1 ||
      proposal.credentialMinutes > CONTRACT.maximumCredentialMinutes ||
      proposal.networkBoundary !== 'private_tls_proposed' ||
      !Array.isArray(proposal.allowedActions) ||
      proposal.allowedActions.length !== 1 ||
      proposal.allowedActions[0] !== 'quota_cleanup_function_only' ||
      proposal.directDelete !== false ||
      proposal.ownerRoleMembership !== false ||
      proposal.applicationRoleMembership !== false ||
      proposal.approvalProof !== 'external_evidence_required' ||
      proposal.auditCustody !== 'independent_append_only_required' ||
      proposal.alertDelivery !== 'independent_delivery_required' ||
      proposal.deploymentEnabled !== false) {
    return Object.freeze({ decision: 'rejected', reason: 'proposal_not_reviewable',
      productionAuthorized: false });
  }
  return Object.freeze({ decision: 'review_required',
    reason: 'external_identity_grants_rotation_and_delivery_not_verified',
    productionAuthorized: false });
}

const AUDIT_KEYS = [
  'schema','sequence','timestamp','runId','status','alertCode','severity',
  'batches','networkRemoved','agentRemoved','previousHash','hash',
];
const MAPPING = Object.freeze({
  maintenance_possible_backlog: { status: 'completed', severity: 'warning' },
  maintenance_operation_failed: { status: 'failed', severity: 'critical' },
  maintenance_configuration_denied: { status: 'failed', severity: 'critical' },
  maintenance_protocol_invalid: { status: 'invalid_output', severity: 'critical' },
});
const validCount = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;

/** Recompute D15C-5D's row digest, but do NOT mistake SHA chaining for a signature. */
export function isValidLocalAuditReceipt(row) {
  if (!exact(row, AUDIT_KEYS) || row.schema !== CONTRACT.auditSchema ||
      !validCount(row.sequence, 2048) || row.sequence === 0 ||
      typeof row.timestamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.timestamp) ||
      !Number.isFinite(Date.parse(row.timestamp)) ||
      !UUID.test(row.runId) || !HEX64.test(row.previousHash) ||
      !HEX64.test(row.hash) || !validCount(row.batches, 3) ||
      !validCount(row.networkRemoved, 750) ||
      !validCount(row.agentRemoved, 750)) return false;
  if (row.alertCode === null) {
    if (row.severity !== 'none' ||
        !['completed', 'overlap_skipped'].includes(row.status) ||
        (row.status === 'overlap_skipped' &&
          (row.batches !== 0 || row.networkRemoved !== 0 || row.agentRemoved !== 0))) {
      return false;
    }
  } else {
    const mapped = Object.hasOwn(MAPPING, row.alertCode) ? MAPPING[row.alertCode] : null;
    if (!mapped || row.status !== mapped.status || row.severity !== mapped.severity ||
        (row.alertCode === 'maintenance_possible_backlog' &&
          (row.batches !== 3 ||
            (row.networkRemoved === 0 && row.agentRemoved === 0))) ||
        (mapped.severity === 'critical' &&
          (row.batches !== 0 || row.networkRemoved !== 0 || row.agentRemoved !== 0))) {
      return false;
    }
  }
  const body = {
    schema: row.schema, sequence: row.sequence, timestamp: row.timestamp,
    runId: row.runId, status: row.status, alertCode: row.alertCode,
    severity: row.severity, batches: row.batches,
    networkRemoved: row.networkRemoved, agentRemoved: row.agentRemoved,
    previousHash: row.previousHash,
  };
  return sha(JSON.stringify(body)) === row.hash;
}

/**
 * Takes a record from an ALREADY verified local D15C-5D journal. This
 * function checks one row but cannot independently attest the journal's
 * custody, completeness or an external anchor. Never sends anything.
 */
export function previewAlertFromAuditReceipt(receipt) {
  if (!isValidLocalAuditReceipt(receipt)) {
    return Object.freeze({ disposition: 'rejected', reason: 'invalid_audit_receipt',
      delivered: false });
  }
  if (receipt.alertCode === null) {
    return Object.freeze({ disposition: 'no_alert', auditSequence: receipt.sequence,
      delivered: false });
  }
  return Object.freeze({
    disposition: 'review_only_not_sent',
    idempotencyKey: sha(`pulse-d15c5e-alert-v1:${receipt.hash}`),
    sourceSchema: CONTRACT.auditSchema,
    auditSequence: receipt.sequence,
    auditHash: receipt.hash,
    code: receipt.alertCode,
    severity: receipt.severity,
    acknowledgementRequired: true,
    destinationConfigured: false,
    delivered: false,
  });
}

/** Preview a bounded retry/ack policy. Does not initiate or schedule retries. */
export function previewFailureHandling(preview, state) {
  if (!exact(preview, [
    'disposition','idempotencyKey','sourceSchema','auditSequence','auditHash',
    'code','severity','acknowledgementRequired','destinationConfigured','delivered',
  ]) || preview.disposition !== 'review_only_not_sent' ||
      preview.sourceSchema !== CONTRACT.auditSchema ||
      !HEX64.test(preview.idempotencyKey) || !HEX64.test(preview.auditHash) ||
      !Number.isSafeInteger(preview.auditSequence) || preview.auditSequence < 1 ||
      !Object.hasOwn(MAPPING, preview.code) ||
      preview.severity !== MAPPING[preview.code].severity ||
      preview.acknowledgementRequired !== true ||
      preview.destinationConfigured !== false || preview.delivered !== false ||
      !exact(state, ['attempts','outcome']) ||
      !validCount(state.attempts, CONTRACT.maximumReviewRetries) ||
      !['not_attempted','temporary_failure','permanent_failure',
        'unverified_delivery','unverified_ack'].includes(state.outcome)) {
    return Object.freeze({ action: 'reject_invalid_review', delivered: false });
  }
  let action = 'blocked_no_live_transport';
  if (state.outcome === 'temporary_failure') {
    action = state.attempts < CONTRACT.maximumReviewRetries ?
      'retry_policy_review_required' : 'dead_letter_and_escalation_review_required';
  } else if (state.outcome === 'permanent_failure') {
    action = 'immediate_escalation_review_required';
  } else if (state.outcome === 'unverified_delivery') {
    action = 'delivery_evidence_and_ack_review_required';
  } else if (state.outcome === 'unverified_ack') {
    action = 'independent_ack_verification_required';
  }
  return Object.freeze({ action, delivered: false });
}
