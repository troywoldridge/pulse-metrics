// Pulse Metrics D15C-5U-2F2I — independent signed pilot-review contract.
// This module has NO database, network, enrollment, migration or write APIs.
// A signature proves only who signed a bounded proposal with a trusted key;
// it does NOT activate the pilot or attest that PostgreSQL inventory is live.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { assessPilotInventory, validatePilotPolicy } from './pilot-inventory-policy.mjs';

const PREFIX = 'REFUSE_D15C5U2F2I';
const PURPOSE = 'pulse-metrics-2f2i-pilot-review-only';
const DOMAIN = 'PULSE-METRICS/D15C-5U-2F2I/SIGNED-PROPOSAL/V1\n';
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]{86}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const TARGET = Object.freeze({
  database: 'pulse_metrics',
  dataDirectory: '/var/lib/postgresql/pulse-metrics-dev-5u2/data',
  socketDirectory: '/var/lib/postgresql/pulse-metrics-dev-5u2/socket',
  port: 55433,
  transport: 'private-unix-socket-no-tcp',
});

function refuse(reason) { throw new Error(`${PREFIX}: ${reason}`); }
function isRecord(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o) &&
    Object.getPrototypeOf(o) === Object.prototype;
}
function exact(value, expected, label) {
  if (!isRecord(value) || Object.keys(value).length !== expected.length ||
      expected.some(k => !Object.hasOwn(value, k))) refuse(`${label}: unexpected object keys`);
}
function requireUUID(value, label) {
  if (typeof value !== 'string' || !UUID4.test(value)) refuse(`${label}: UUIDv4 required`);
}
function requireDate(value, label) {
  if (typeof value !== 'string' || !ISO.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) refuse(`${label}: canonical UTC instant required`);
  return Date.parse(value);
}
// Our own deliberately small canonical JSON dialect: sorted object keys,
// strict finite safe integers, no floats, no undefined, no duplicate keys.
// Canonical-text comparison after JSON.parse rejects duplicate keys and
// alternative encodings, not just altered values.
export function canonicalJSON(value, depth = 0) {
  if (depth > 10) refuse('JSON depth limit exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) refuse('unsafe or fractional number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 100) refuse('oversized array');
    return `[${value.map(x => canonicalJSON(x, depth + 1)).join(',')}]`;
  }
  if (!isRecord(value)) refuse('invalid JSON object');
  if (Object.keys(value).length > 32) refuse('oversized JSON object');
  if (Object.keys(value).some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) refuse('unsafe JSON key');
  return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${canonicalJSON(value[k], depth + 1)}`).join(',')}}`;
}
export function parseCanonicalJSON(raw, label = 'JSON') {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192 ||
      raw.length === 0 || raw.includes('\u0000')) refuse(`${label}: invalid input length`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { refuse(`${label}: malformed JSON`); }
  if (canonicalJSON(parsed) !== raw) refuse(`${label}: noncanonical or ambiguous JSON`);
  return parsed;
}

export function validatePilotManifest(manifest) {
  exact(manifest, ['version', 'purpose', 'environment', 'target', 'ownerUserId',
    'policy', 'approval', 'issuedAt', 'expiresAt'], 'pilot manifest');
  if (manifest.version !== 1 || manifest.purpose !== PURPOSE ||
      manifest.environment !== 'isolated-local-development') refuse('manifest purpose or environment invalid');
  exact(manifest.target, Object.keys(TARGET), 'database target');
  for (const [key, val] of Object.entries(TARGET)) {
    if (manifest.target[key] !== val) refuse(`target ${key} does not match reviewed local cluster`);
  }
  requireUUID(manifest.ownerUserId, 'owner user');
  // Reuse the previously tested 2F2G exact scope validator.
  const policy = validatePilotPolicy(manifest.policy);
  if (policy.mode !== 'bounded' || policy.agentStatus !== 'active' ||
      !UUID4.test(policy.organizationId) || !UUID4.test(policy.agentId) ||
      policy.expectedSamplesMax > 100) refuse('scope exceeds preliminary one-agent review');
  exact(manifest.approval, ['reviewId', 'reviewer', 'independentReview'], 'approval metadata');
  if (typeof manifest.approval.reviewId !== 'string' ||
      !/^PM-[A-Z0-9]{4,32}$/.test(manifest.approval.reviewId) ||
      typeof manifest.approval.reviewer !== 'string' ||
      !/^[a-zA-Z0-9._-]{3,64}$/.test(manifest.approval.reviewer) ||
      manifest.approval.independentReview !== 'required-outside-database') {
    refuse('review metadata invalid; metadata alone is not authorization');
  }
  const issued = requireDate(manifest.issuedAt, 'issuedAt');
  const expires = requireDate(manifest.expiresAt, 'expiresAt');
  if (!(issued < expires && expires - issued <= 24 * 60 * 60 * 1000)) {
    refuse('approval time window must be positive and at most 24 hours');
  }
  return manifest;
}

export function approvalSigningBytes(manifest) {
  validatePilotManifest(manifest);
  return Buffer.from(DOMAIN + canonicalJSON(manifest), 'utf8');
}

export function trustedPublicKeyFingerprint(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----\n') ||
      !publicKeyPem.trimEnd().endsWith('-----END PUBLIC KEY-----')) {
    refuse('only explicit public PEM keys may be used as trust anchors');
  }
  let key;
  try { key = createPublicKey(publicKeyPem); } catch { refuse('invalid trusted public key'); }
  if (key.asymmetricKeyType !== 'ed25519' || key.type !== 'public') {
    refuse('only Ed25519 public keys accepted');
  }
  const hash = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  return Object.freeze({ key, hash });
}

export function verifySignedPilotApproval(rawEnvelope, trustedKeyPem, externallyReviewedKeySha256, now = Date.now()) {
  if (typeof externallyReviewedKeySha256 !== 'string' || !SHA256.test(externallyReviewedKeySha256)) {
    refuse('an independently reviewed trust-anchor fingerprint is required');
  }
  if (!Number.isSafeInteger(now) || now < 0) refuse('invalid review clock');
  const envelope = parseCanonicalJSON(rawEnvelope, 'signed envelope');
  exact(envelope, ['format', 'manifest', 'signature'], 'signed envelope');
  if (envelope.format !== 'pulse-metrics/2f2i/ed25519-v1') refuse('unsupported signature envelope');
  const manifest = validatePilotManifest(envelope.manifest);
  if (typeof envelope.signature !== 'string' || !BASE64URL.test(envelope.signature)) {
    refuse('invalid signature encoding');
  }
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== envelope.signature) {
    refuse('noncanonical signature');
  }
  const trusted = trustedPublicKeyFingerprint(trustedKeyPem);
  if (trusted.hash !== externallyReviewedKeySha256) refuse('public key differs from independent trust anchor');
  if (!verifySignature(null, approvalSigningBytes(manifest), trusted.key, signature)) {
    refuse('Ed25519 signature verification failed');
  }
  const issued = requireDate(manifest.issuedAt, 'issuedAt');
  const expires = requireDate(manifest.expiresAt, 'expiresAt');
  if (now < issued || now >= expires) refuse('signed approval is not currently valid');
  // Do NOT expose manifest content or call a live database from this function.
  return Object.freeze({ verifiedSignature: true, reviewOnly: true, policy: Object.freeze({ ...manifest.policy }),
    ownerUserId: manifest.ownerUserId });
}

export function assessSignedFixture(rawEnvelope, trustedKeyPem, externallyReviewedKeySha256, fixture, now = Date.now()) {
  const signature = verifySignedPilotApproval(rawEnvelope, trustedKeyPem, externallyReviewedKeySha256, now);
  const decision = assessPilotInventory(fixture, signature.policy);
  if (decision.mode !== 'bounded' || decision.agentCount !== 1) refuse('fixture not within reviewed scope');
  // The existing 2F2G snapshot cannot yet attest the exact ownerUserId.
  // Even with a signed manifest this result is NEVER operational authorization.
  return Object.freeze({ fixtureMatchesPolicy: true, signatureVerified: true, operationalAuthorization: false });
}

export const APPROVAL_PURPOSE = PURPOSE;
export const REVIEWED_LOCAL_TARGET = TARGET;
