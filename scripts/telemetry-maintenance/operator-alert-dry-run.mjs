#!/usr/bin/env node
/**
 * D15C-5E OFFLINE, DISPOSABLE-ONLY review demonstration.
 * Creates a 0700 temp directory and a 0600 test journal with synthetic data.
 * Uses the D15C-5D local journal implementation, NO PostgreSQL or network.
 * Never configures alert recipients or provisions an operator.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constants, closeSync, mkdirSync, openSync, rmdirSync, statSync,
  unlinkSync } from 'node:fs';
import { appendAuditRecord, verifyAuditJournal } from './maintenance-audit-policy.mjs';
import { CONTRACT, previewAlertFromAuditReceipt, previewFailureHandling,
  reviewOperatorProposal } from './operator-alert-contract.mjs';

const PG_OVERRIDE = /^(?:PGPASSWORD|PGPASSFILE|PGHOST|PGHOSTADDR|PGPORT|PGUSER|PGDATABASE|PGSERVICE|PGSERVICEFILE|PGOPTIONS|PGCLUSTER|PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT)$/;
function guard() {
  return process.argv.length === 2 &&
    process.env.PULSE_D15C5E_DISPOSABLE_ONLY === 'YES' &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.DATABASE_URL &&
    !Object.keys(process.env).some(k => PG_OVERRIDE.test(k));
}
if (!guard()) {
  console.log('D15C5E_REVIEW {"event":"configuration_denied","live":false}');
  process.exit(1);
}

let dir;
let created = false;
try {
  dir = `/tmp/pulse-maint-audit-${randomBytes(5).toString('hex')}`;
  mkdirSync(dir, { mode: 0o700 });
  created = true;
  const marker = `${dir}/.pulse-maintenance-audit-marker`;
  const markerFd = openSync(marker, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  closeSync(markerFd);
  const classifications = [
    { status:'completed',alertCode:null,severity:'none',batches:1,networkRemoved:0,agentRemoved:0 },
    { status:'completed',alertCode:'maintenance_possible_backlog',severity:'warning',batches:3,networkRemoved:750,agentRemoved:750 },
    { status:'failed',alertCode:'maintenance_operation_failed',severity:'critical',batches:0,networkRemoved:0,agentRemoved:0 },
  ];
  for (const row of classifications) appendAuditRecord(dir, row);
  const verified = verifyAuditJournal(dir);
  assert.equal(verified.sequence, 3);
  assert.equal(statSync(`${dir}/maintenance-audit.jsonl`).mode & 0o777, 0o600);
  const previews = verified.rows.map(previewAlertFromAuditReceipt);
  assert.deepEqual(previews.map(p=>p.disposition), [
    'no_alert','review_only_not_sent','review_only_not_sent',
  ]);
  assert.deepEqual(previews.map(p=>p.severity ?? 'none'), [
    'none','warning','critical',
  ]);
  assert.equal(previews[1].idempotencyKey,
    previewAlertFromAuditReceipt(verified.rows[1]).idempotencyKey);
  assert.equal(previewFailureHandling(previews[2],
    {attempts:3,outcome:'temporary_failure'}).action,
    'dead_letter_and_escalation_review_required');
  assert.equal(CONTRACT.productionAuthorization, false);
  assert.equal(CONTRACT.liveDelivery, false);
  assert.equal(reviewOperatorProposal({deploymentEnabled:true}).productionAuthorized, false);
  console.log('PASS: D15C-5E verified three synthetic 5D audit receipts');
  console.log('PASS: warning and critical previews are deduplicated and NOT delivered');
  console.log('PASS: exhausted retry requires manual dead-letter/escalation review');
  console.log('PASS: operator proposals cannot authorize a production identity');
  console.log('D15C-5E OFFLINE CONTRACT REHEARSAL PASSED');
  console.log('PUBLIC LAUNCH: NO_GO | no operator, alert transport or scheduler');
} catch {
  console.error('REFUSE_D15C5E: offline contract rehearsal failed');
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      // Exact private names created in this run; do not recursively remove any
      // caller-provided path or follow symbolic links.
      unlinkSync(`${dir}/maintenance-audit.jsonl`);
      unlinkSync(`${dir}/.pulse-maintenance-audit-marker`);
      rmdirSync(dir);
      console.log('PASS: disposable private audit journal removed');
    } catch {
      console.error('REFUSE_D15C5E: private journal cleanup failed');
      process.exitCode = 1;
    }
  }
}
