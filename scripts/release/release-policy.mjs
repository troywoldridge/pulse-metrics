// Phase 2E3C5D3 — PURE release approval policy. NO database access.
// This is a synthetic rehearsal, not an authenticated production approval UI.
// All release fields and the canary SQL are independently pinned below.
import { createHash, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHECKPOINT = '80941db15520897ab3d8532bd7793afcf3cc3873';
export const CATALOG_SHA256 = '6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977';
export const MIGRATION_SHA256 = 'f1ac259a011767e7afeb4ded30caa15e1c824275f54616402d16dec7473406d5';
export const LOCK_KEYS = Object.freeze([1347767379, 1296389202]);
const MIGRATION_URL = new URL('./rehearsal-migration.sql', import.meta.url);

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function insist(condition, reason) {
  if (!condition) throw Error(`REFUSE_RELEASE: ${reason}`);
}

export function reviewedMigrationSql() {
  const bytes = readFileSync(fileURLToPath(MIGRATION_URL));
  insist(sha256(bytes) === MIGRATION_SHA256, 'reviewed migration SQL hash mismatch');
  return bytes.toString('utf8');
}

export function reviewedPlan() {
  reviewedMigrationSql();
  return Object.freeze({
    format: 'pulse-synthetic-release-v1',
    releaseId: '2e3c5d3-synthetic-canary-001',
    reviewedCheckpoint: CHECKPOINT,
    database: 'pulse_metrics',
    baselineCatalogSha256: CATALOG_SHA256,
    migrationPath: 'scripts/release/rehearsal-migration.sql',
    migrationSha256: MIGRATION_SHA256,
    expectedPrivilegedReceipts: 6,
  });
}

export function planDigest(plan) {
  return sha256(Buffer.from('pulse-release-plan-v1\n' + JSON.stringify(plan), 'utf8'));
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function verifyPlan(plan) {
  const reviewed = reviewedPlan();
  insist(exactKeys(plan, Object.keys(reviewed)) && JSON.stringify(plan) === JSON.stringify(reviewed),
    'plan differs from immutable reviewed release target and migration');
  return planDigest(reviewed);
}

function canonicalIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}

export function approvalMessage(approval) {
  // Fixed order, fixed domain separation; no signature field in signed bytes.
  return Buffer.from('pulse-release-approval-v1\n' + JSON.stringify({
    planSha256: approval.planSha256,
    keyId: approval.keyId,
    subject: approval.subject,
    role: approval.role,
    issuedAt: approval.issuedAt,
    expiresAt: approval.expiresAt,
  }), 'utf8');
}

export function verifyApprovals(plan, approvals, trustedKeys, nowMs = Date.now()) {
  const digest = verifyPlan(plan); // ALWAYS before any DB connection.
  insist(Array.isArray(approvals) && approvals.length === 2, 'exactly two independent approvals required');
  insist(trustedKeys instanceof Map, 'trusted signer registry is required');
  insist(Number.isFinite(nowMs), 'invalid verification clock');
  const actors = new Map();
  const seenKeys = new Set();
  const seenSubjects = new Set();
  const required = ['operator', 'reviewer'];
  for (const approval of approvals) {
    insist(exactKeys(approval, ['planSha256', 'keyId', 'subject', 'role', 'issuedAt', 'expiresAt', 'signature']),
      'malformed or ambiguous approval fields');
    insist(required.includes(approval.role) && !actors.has(approval.role), 'duplicate/missing approval role');
    insist(typeof approval.keyId === 'string' && /^[a-z0-9-]{3,48}$/.test(approval.keyId),
      'invalid key identity');
    insist(!seenKeys.has(approval.keyId), 'approval key reused');
    const trusted = trustedKeys.get(approval.keyId);
    insist(trusted && trusted.role === approval.role && trusted.subject === approval.subject &&
      trusted.publicKey && typeof approval.subject === 'string' && approval.subject.length > 0,
      'approver identity is not authorized by trusted registry');
    insist(!seenSubjects.has(approval.subject), 'same person cannot approve twice');
    insist(approval.planSha256 === digest, 'approval bound to a different release plan');
    const issued = canonicalIso(approval.issuedAt);
    const expires = canonicalIso(approval.expiresAt);
    insist(Number.isFinite(issued) && Number.isFinite(expires) &&
      issued <= nowMs && expires > nowMs && expires > issued &&
      expires - issued <= 10 * 60_000 && nowMs - issued <= 10 * 60_000,
      'approval expired, premature or outside ten-minute window');
    insist(typeof approval.signature === 'string' &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(approval.signature), 'invalid signature encoding');
    const signature = Buffer.from(approval.signature, 'base64');
    insist(signature.length === 64 && signature.toString('base64') === approval.signature,
      'noncanonical Ed25519 signature');
    insist(verifySignature(null, approvalMessage(approval), trusted.publicKey, signature),
      'signature did not verify against trusted approver key');
    actors.set(approval.role, { subject: approval.subject, keyId: approval.keyId });
    seenKeys.add(approval.keyId);
    seenSubjects.add(approval.subject);
  }
  insist(actors.size === 2 && actors.has('operator') && actors.has('reviewer'),
    'operator and independent reviewer both required');
  return Object.freeze({ digest, operator: actors.get('operator'), reviewer: actors.get('reviewer') });
}
