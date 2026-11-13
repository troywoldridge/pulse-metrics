import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CONTRACT, reviewOperatorProposal, isValidLocalAuditReceipt,
  previewAlertFromAuditReceipt, previewFailureHandling } from './operator-alert-contract.mjs';

const proposal = () => ({
  schema: CONTRACT.schema, principalType: 'dedicated_nonhuman',
  databaseRole: CONTRACT.proposedRole,
  credentialSource: 'workload_identity_proposed', credentialMinutes: 30,
  networkBoundary: 'private_tls_proposed', allowedActions: ['quota_cleanup_function_only'],
  directDelete: false, ownerRoleMembership: false, applicationRoleMembership: false,
  approvalProof: 'external_evidence_required',
  auditCustody: 'independent_append_only_required',
  alertDelivery: 'independent_delivery_required', deploymentEnabled: false,
});
function fakeReceipt({ status='failed', alertCode='maintenance_operation_failed', severity='critical',
  batches=0, networkRemoved=0, agentRemoved=0 } = {}) {
  const body = {
    schema: 'pulse-maintenance-audit/v1', sequence: 1,
    timestamp: '2026-11-13T00:00:00.000Z',
    runId: '123e4567-e89b-42d3-a456-426614174000', status, alertCode, severity,
    batches, networkRemoved, agentRemoved, previousHash: '0'.repeat(64),
  };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

test('D15C-5E well-formed operator proposal still requires external approval', () => {
  assert.deepEqual(reviewOperatorProposal(proposal()), {
    decision: 'review_required',
    reason: 'external_identity_grants_rotation_and_delivery_not_verified',
    productionAuthorized: false,
  });
});
test('D15C-5E privileged database roles and direct delete are denied', () => {
  for (const update of [
    { databaseRole: 'pulse_metrics_app' }, { databaseRole:'postgres' },
    { directDelete:true }, { ownerRoleMembership:true },
    { applicationRoleMembership:true }, { deploymentEnabled:true },
    {allowedActions:['quota_cleanup_function_only','table_delete']},
  ]) assert.equal(reviewOperatorProposal({...proposal(),...update}).decision,'rejected');
});
test('D15C-5E rejects embedded secrets, recipients and unreviewed key extensions', () => {
  for (const update of [{ password:'do-not-store' }, { token:'abc' },
    { email:'secret@example.com' }, { webhook:'https://example.com' }]) {
    assert.equal(reviewOperatorProposal({...proposal(),...update}).decision,'rejected');
  }
});
test('D15C-5E rejects unbounded credentials and unsupported authentication', () => {
  for (const update of [{ credentialMinutes:61 }, {credentialMinutes:0},
    {credentialMinutes:30.5}, {credentialSource:'static_password'},
    {networkBoundary:'public_internet'}]) {
    assert.equal(reviewOperatorProposal({...proposal(),...update}).decision,'rejected');
  }
});
test('D15C-5E refuses self-attested approval and fake durable stores', () => {
  for (const update of [{approvalProof:'approved'}, {auditCustody:'local_only'},
    {alertDelivery:'delivered'}, {schema:'pulse-maintenance-ops-review/v2'}]) {
    assert.equal(reviewOperatorProposal({...proposal(),...update}).decision,'rejected');
  }
});
test('D15C-5E valid SHA audit receipt produces review-only critical preview', () => {
  const receipt = fakeReceipt();
  assert.equal(isValidLocalAuditReceipt(receipt), true);
  const preview = previewAlertFromAuditReceipt(receipt);
  assert.equal(preview.disposition,'review_only_not_sent');
  assert.equal(preview.severity,'critical');
  assert.equal(preview.delivered,false);
  assert.equal(preview.destinationConfigured,false);
  assert.match(preview.idempotencyKey,/^[0-9a-f]{64}$/);
});
test('D15C-5E repeated receipt gets same idempotency key', () => {
  const receipt = fakeReceipt();
  assert.equal(previewAlertFromAuditReceipt(receipt).idempotencyKey,
    previewAlertFromAuditReceipt({...receipt}).idempotencyKey);
});
test('D15C-5E warning requires bounded three-batch evidence', () => {
  const okay = fakeReceipt({status:'completed',alertCode:'maintenance_possible_backlog',
    severity:'warning',batches:3,networkRemoved:750,agentRemoved:750});
  assert.equal(previewAlertFromAuditReceipt(okay).severity, 'warning');
  const wrong = fakeReceipt({status:'completed',alertCode:'maintenance_possible_backlog',
    severity:'warning',batches:2,networkRemoved:500,agentRemoved:500});
  assert.equal(previewAlertFromAuditReceipt(wrong).disposition,'rejected');
});
test('D15C-5E a normal completion or overlap is not an alert', () => {
  const completed = fakeReceipt({status:'completed',alertCode:null,severity:'none',batches:1});
  const overlap = fakeReceipt({status:'overlap_skipped',alertCode:null,severity:'none'});
  assert.equal(previewAlertFromAuditReceipt(completed).disposition,'no_alert');
  assert.equal(previewAlertFromAuditReceipt(overlap).disposition,'no_alert');
});
test('D15C-5E modified count, hash, code, extra field are rejected', () => {
  const row = fakeReceipt();
  for (const forged of [
    {...row,hash:'f'.repeat(64)}, {...row,networkRemoved:1},
    {...row,alertCode:'freeform'}, {...row,password:'leak'},
    {...row, severity:'warning'},
  ]) assert.deepEqual(previewAlertFromAuditReceipt(forged),
    {disposition:'rejected',reason:'invalid_audit_receipt',delivered:false});
});
test('D15C-5E critical mapping must agree with failed classification', () => {
  const bad = fakeReceipt({status:'completed',severity:'critical'});
  assert.equal(previewAlertFromAuditReceipt(bad).disposition,'rejected');
});
test('D15C-5E retry and escalation previews never send or confirm delivery', () => {
  const p = previewAlertFromAuditReceipt(fakeReceipt());
  const cases = [
    [0,'not_attempted','blocked_no_live_transport'],
    [1,'temporary_failure','retry_policy_review_required'],
    [3,'temporary_failure','dead_letter_and_escalation_review_required'],
    [2,'permanent_failure','immediate_escalation_review_required'],
    [1,'unverified_delivery','delivery_evidence_and_ack_review_required'],
    [1,'unverified_ack','independent_ack_verification_required'],
  ];
  for(const [attempts,outcome,action] of cases) {
    assert.deepEqual(previewFailureHandling(p,{attempts,outcome}), {action,delivered:false});
  }
});
test('D15C-5E invalid delivery handling never triggers a send', () => {
  const p = previewAlertFromAuditReceipt(fakeReceipt());
  for (const state of [{attempts:4,outcome:'temporary_failure'},
    {attempts:0,outcome:'sent'}, {attempts:-1,outcome:'not_attempted'},
    {attempts:1,outcome:'temporary_failure',endpoint:'https://x'}]) {
    assert.equal(previewFailureHandling(p,state).action,'reject_invalid_review');
  }
});
test('D15C-5E no-ack, no-route and no-live invariant', () => {
  assert.equal(CONTRACT.liveDelivery,false);
  assert.equal(CONTRACT.productionAuthorization,false);
  assert.equal(CONTRACT.publicLaunch,'NO_GO');
  assert.equal(previewFailureHandling(previewAlertFromAuditReceipt(fakeReceipt({
    status:'completed',alertCode:null,severity:'none',batches:1
  })),{attempts:0,outcome:'not_attempted'}).action,'reject_invalid_review');
});
