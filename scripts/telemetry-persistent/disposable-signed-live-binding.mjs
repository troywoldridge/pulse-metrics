#!/usr/bin/env node
// D15C-5U-2F2L — TEST-ONLY synthetic Ed25519 binding to streamed
// PostgreSQL 16 disposable identity evidence. No private key is saved.
// This must NEVER be used as trusted approval, live attestation or admission.
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  APPROVAL_PURPOSE, REVIEWED_LOCAL_TARGET, approvalSigningBytes,
  canonicalJSON, trustedPublicKeyFingerprint,
} from './pilot-authorization-policy.mjs';
import {
  compareSignedIdentityEvidence, parseIdentityEvidence,
  validatePilotIdentityEvidence,
} from './pilot-identity-evidence.mjs';

const REFUSAL = 'REFUSE_D15C5U2F2L: synthetic signed identity rehearsal denied';
const FORMAT = 'pulse-metrics/2f2i/ed25519-v1';
const HOUR = 60 * 60 * 1000;
function refuse() { throw new Error(REFUSAL); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function expectRejected(action) {
  try { action(); } catch (error) {
    if (error instanceof Error && /^REFUSE_D15C5U2F2[IJ]:/.test(error.message)) return;
    refuse();
  }
  refuse();
}
function checkReview(result) {
  if (result.signatureVerified !== true || result.identityContractMatches !== true ||
      result.databaseAttested !== false || result.operationalAuthorization !== false ||
      result.reviewOnly !== true || Object.keys(result).length !== 5) refuse();
}

// Synthetic identity chosen solely from a guarded disposable database fixture.
// The SHA256 key fingerprint is generated in the SAME PROCESS for a contract
// demonstration; it is NOT an independently trusted real-world approval key.
export function rehearseSyntheticSignedLiveIdentity(evidence, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - 2 * HOUR) refuse();
  const { organizationId, ownerUserId, agentId } = validatePilotIdentityEvidence(evidence);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const testOnlySelfPinnedFingerprint = trustedPublicKeyFingerprint(publicPem).hash;
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + HOUR).toISOString();
  const manifest = {
    version: 1, purpose: APPROVAL_PURPOSE, environment: 'isolated-local-development',
    target: { ...REVIEWED_LOCAL_TARGET }, ownerUserId,
    policy: { version: 1, mode: 'bounded', organizationId, agentId,
      expectedSamplesMin: 1, expectedSamplesMax: 100, agentStatus: 'active' },
    approval: { reviewId: 'PM-2F2LSYNTHETIC', reviewer: 'synthetic-test-only',
      independentReview: 'required-outside-database' },
    issuedAt, expiresAt,
  };
  function signed(manifestToSign = manifest) {
    return canonicalJSON({ format: FORMAT, manifest: manifestToSign,
      signature: sign(null, approvalSigningBytes(manifestToSign), privateKey).toString('base64url') });
  }
  const envelope = signed();
  const verify = (raw, key = publicPem, digest = testOnlySelfPinnedFingerprint,
    facts = evidence, instant = now) => compareSignedIdentityEvidence(raw, key, digest, facts, instant);
  checkReview(verify(envelope));

  // Each probe MUST be rejected; this includes re-signed wrong identity
  // proposals (a signature alone cannot establish owner/tenant membership).
  expectRejected(() => verify(envelope, publicPem, '0'.repeat(64)));
  const foreignKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  expectRejected(() => verify(envelope, foreignKey));
  const mismatched = clone(manifest);
  mismatched.ownerUserId = '11111111-1111-4111-8111-111111111111';
  if (mismatched.ownerUserId === ownerUserId) mismatched.ownerUserId = '22222222-2222-4222-8222-222222222222';
  expectRejected(() => verify(signed(mismatched)));
  const wrongAgent = clone(manifest);
  wrongAgent.policy.agentId = '33333333-3333-4333-8333-333333333333';
  if (wrongAgent.policy.agentId === agentId) wrongAgent.policy.agentId = '44444444-4444-4444-8444-444444444444';
  expectRejected(() => verify(signed(wrongAgent)));
  const wrongOrg = clone(manifest);
  wrongOrg.policy.organizationId = '55555555-5555-4555-8555-555555555555';
  if (wrongOrg.policy.organizationId === organizationId) wrongOrg.policy.organizationId = '66666666-6666-4666-8666-666666666666';
  expectRejected(() => verify(signed(wrongOrg)));
  expectRejected(() => verify(envelope, publicPem, testOnlySelfPinnedFingerprint,
    evidence, now + HOUR));
  const overLimit = clone(manifest);
  overLimit.policy.expectedSamplesMax = 101;
  expectRejected(() => verify(signed(overLimit)));
  const alteredEvidence = clone(evidence);
  alteredEvidence.credentials[0].revoked = true;
  expectRejected(() => verify(envelope, publicPem, testOnlySelfPinnedFingerprint, alteredEvidence));
  const extraUserEvidence = clone(evidence);
  extraUserEvidence.users.push({ id: '77777777-7777-4777-8777-777777777777' });
  expectRejected(() => verify(envelope, publicPem, testOnlySelfPinnedFingerprint, extraUserEvidence));

  return Object.freeze({ syntheticSignatureMatches: true, syntheticNegativeChecks: 9,
    selfPinnedTestOnlyKey: true, externallyApprovedSigner: false,
    databaseAttestedBySignature: false, operationalAuthorization: false,
    persistentTelemetryWritesAuthorized: false });
}

export function verifySyntheticEvidenceFromStdin(text, now = Date.now()) {
  const { evidence } = parseIdentityEvidence(text);
  return rehearseSyntheticSignedLiveIdentity(evidence, now);
}

function plan() {
  process.stdout.write([
    '========== D15C-5U-2F2L SYNTHETIC SIGNATURE BINDING PLAN ==========',
    'Input: one SQL JSON row from the exact disposable 55432 identity auditor.',
    'Generates an ephemeral Ed25519 key ONLY IN MEMORY to exercise 2F2I + 2F2J.',
    'The key fingerprint is SELF-PINNED: NOT an independently trusted signing authority.',
    'The proposal target stays the review-only 55433 contract; SQL evidence is 55432.',
    'This is a synthetic integration rehearsal, never an activation or approval.',
    'NO NETWORK | NO POSTGRESQL START | NO AGENT | NO WRITES | PUBLIC LAUNCH: NO_GO',
  ].join('\n') + '\n');
}
function run(args) {
  if (args.length === 1 && args[0] === '--plan') { plan(); return; }
  if (args.length === 1 && args[0] === '--synthetic-disposable-stdin') {
    verifySyntheticEvidenceFromStdin(readFileSync(0, 'utf8'));
    process.stdout.write('PASS: disposable SQL identity evidence matches a test-only signed manifest; NO AUTHORIZATION\n');
    process.stdout.write('PASS: 9 synthetic signed-identity rejection probes; no real signer, key or identity admitted\n');
    return;
  }
  refuse();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run(process.argv.slice(2)); }
  catch { process.stderr.write(REFUSAL + '\n'); process.exitCode = 1; }
}
