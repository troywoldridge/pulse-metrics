import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  approvalMessage, planDigest, reviewedPlan, verifyApprovals, verifyPlan,
} from './release-policy.mjs';

function fixture() {
  const now = Date.parse('2026-11-12T17:00:00.000Z');
  const plan = reviewedPlan();
  const registry = new Map();
  const approvals = [];
  for (const [role, keyId, subject] of [
    ['operator', 'synthetic-operator-1', 'subject-alpha'],
    ['reviewer', 'synthetic-reviewer-1', 'subject-beta'],
  ]) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const evidence = {
      planSha256: planDigest(plan), keyId, subject, role,
      issuedAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    registry.set(keyId, { publicKey, role, subject });
    approvals.push({ ...evidence, signature: sign(null, approvalMessage(evidence), privateKey).toString('base64') });
  }
  return { plan, registry, approvals, now };
}

test('reviewed immutable release plan and SQL hash validate', () => {
  const { plan } = fixture();
  assert.equal(verifyPlan(plan), planDigest(plan));
});
test('two independently signed operator/reviewer approvals pass', () => {
  const { plan, registry, approvals, now } = fixture();
  const result = verifyApprovals(plan, approvals, registry, now);
  assert.equal(result.operator.subject, 'subject-alpha');
  assert.equal(result.reviewer.subject, 'subject-beta');
});
test('unapproved release is refused', () => {
  const { plan, registry, now } = fixture();
  assert.throws(() => verifyApprovals(plan, [], registry, now), /exactly two/);
});
test('one approval, or duplicated approval, is refused', () => {
  const { plan, registry, approvals, now } = fixture();
  assert.throws(() => verifyApprovals(plan, [approvals[0]], registry, now), /exactly two/);
  assert.throws(() => verifyApprovals(plan, [approvals[0], approvals[0]], registry, now), /duplicate\/missing/);
});
test('plan cannot change release id, database or migration digest', () => {
  const { plan, registry, approvals, now } = fixture();
  for (const mutation of [
    { releaseId: 'someone-else' }, { database: 'postgres' },
    { migrationSha256: '0'.repeat(64) }, { baselineCatalogSha256: '0'.repeat(64) },
  ]) {
    assert.throws(() => verifyApprovals({ ...plan, ...mutation }, approvals, registry, now), /plan differs/);
  }
});
test('signature cannot be reused for another plan digest', () => {
  const { plan, registry, approvals, now } = fixture();
  const tampered = approvals.map(a => ({ ...a }));
  tampered[0].planSha256 = 'a'.repeat(64);
  assert.throws(() => verifyApprovals(plan, tampered, registry, now), /different release plan/);
});
test('signature change and noncanonical encoding are refused', () => {
  const { plan, registry, approvals, now } = fixture();
  const forged = approvals.map(a => ({ ...a }));
  forged[1].signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => verifyApprovals(plan, forged, registry, now), /signature did not verify/);
  forged[1].signature = 'not-base64!';
  assert.throws(() => verifyApprovals(plan, forged, registry, now), /signature encoding/);
});
test('expired or future-issued approvals fail closed', () => {
  const { plan, registry, approvals, now } = fixture();
  assert.throws(() => verifyApprovals(plan, approvals, registry, now + 61_000), /expired|window/);
  assert.throws(() => verifyApprovals(plan, approvals, registry, now - 30_000), /premature|window/);
});
test('untrusted key, altered subject and reused person are refused', () => {
  const { plan, registry, approvals, now } = fixture();
  const unknownRegistry = new Map(registry);
  unknownRegistry.delete('synthetic-reviewer-1');
  assert.throws(() => verifyApprovals(plan, approvals, unknownRegistry, now), /not authorized/);
  const altered = approvals.map(a => ({ ...a }));
  altered[0].subject = 'impersonated';
  assert.throws(() => verifyApprovals(plan, altered, registry, now), /not authorized/);
  const sameSubjectRegistry = new Map(registry);
  sameSubjectRegistry.set('synthetic-reviewer-1', { ...registry.get('synthetic-reviewer-1'), subject: 'subject-alpha' });
  altered[0] = approvals[0];
  altered[1].subject = 'subject-alpha';
  assert.throws(() => verifyApprovals(plan, altered, sameSubjectRegistry, now), /same person/);
});
test('unknown approval fields and duplicate roles are refused', () => {
  const { plan, registry, approvals, now } = fixture();
  const unexpected = approvals.map(a => ({ ...a }));
  unexpected[0].override = true;
  assert.throws(() => verifyApprovals(plan, unexpected, registry, now), /malformed/);
  const duplicateRoles = approvals.map(a => ({ ...a }));
  duplicateRoles[1].role = 'operator';
  assert.throws(() => verifyApprovals(plan, duplicateRoles, registry, now), /duplicate\/missing/);
});
