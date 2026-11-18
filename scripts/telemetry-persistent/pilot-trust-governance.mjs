// Pulse Metrics D15C-5U-2F2M — OFFLINE independent signer-governance contract.
// Verification is a review, NEVER authorization to enroll, connect or write.
// No network, DB, filesystem, key generation, signing or private-key APIs.
import { createHash, verify as verifyEd25519 } from 'node:crypto';
import {
  canonicalJSON, parseCanonicalJSON, trustedPublicKeyFingerprint,
  verifySignedPilotApproval, REVIEWED_LOCAL_TARGET,
} from './pilot-authorization-policy.mjs';

const PREFIX = 'REFUSE_D15C5U2F2M';
const ROSTER_DOMAIN = 'PULSE-METRICS/D15C-5U-2F2M/ROOT-SIGNED-ROSTER/V1\n';
const REVIEW_DOMAIN = 'PULSE-METRICS/D15C-5U-2F2M/INDEPENDENT-REVIEW/V1\n';
const REGISTRY_FORMAT = 'pulse-metrics/2f2m/root-signed-roster-v1';
const REVIEW_FORMAT = 'pulse-metrics/2f2m/independent-review-v1';
const PURPOSE = 'pulse-metrics-2f2m-offline-trust-review-only';
const SHA = /^[0-9a-f]{64}$/;
const SIG = /^[a-zA-Z0-9_-]{86}$/;
const ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function refuse() { throw new Error(`${PREFIX}: trust governance rejected`); }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function exact(o, keys) {
  if (!isObject(o) || Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o,k))) refuse();
}
function date(s) {
  if (typeof s !== 'string' || !ISO.test(s) || !Number.isFinite(Date.parse(s)) ||
      new Date(s).toISOString() !== s) refuse();
  return Date.parse(s);
}
function sha(s) { if (typeof s !== 'string' || !SHA.test(s)) refuse(); return s; }
function id(s) { if (typeof s !== 'string' || !ID.test(s)) refuse(); return s; }
function parse(raw) { try { return parseCanonicalJSON(raw, '2F2M canonical envelope'); } catch { refuse(); } }
function hash(raw) { return createHash('sha256').update(raw,'utf8').digest('hex'); }
function signature(raw) {
  if (typeof raw !== 'string' || !SIG.test(raw)) refuse();
  const bytes = Buffer.from(raw,'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== raw) refuse();
  return bytes;
}
function verify(key, domain, message, sig) {
  if (!verifyEd25519(null,Buffer.from(domain + canonicalJSON(message),'utf8'),key,signature(sig))) refuse();
}
function targetMatches(actual) {
  exact(actual,Object.keys(REVIEWED_LOCAL_TARGET));
  for (const [key,value] of Object.entries(REVIEWED_LOCAL_TARGET)) {
    if (actual[key] !== value) refuse();
  }
}

/**
 * Read-only roster assessment. The public root key digest AND monotonic serial
 * floor must come from an independent, version-controlled operator record.
 * This function cannot establish how that external record was obtained or
 * guarantee no newer revocation occurred since the signed roster was issued.
 */
export function verifySignedTrustRoster(rawRegistry, externalRootPublicPem,
  independentRootFingerprint, independentlyKnownMinSerial, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(independentlyKnownMinSerial) || independentlyKnownMinSerial < 1) refuse();
  sha(independentRootFingerprint);
  const root = trustedPublicKeyFingerprint(externalRootPublicPem);
  if (root.hash !== independentRootFingerprint) refuse();
  const envelope = parse(rawRegistry);
  exact(envelope,['format','roster','signature']);
  if (envelope.format !== REGISTRY_FORMAT) refuse();
  const roster = envelope.roster;
  exact(roster,['version','purpose','environment','target','serial','issuedAt','expiresAt','authorities']);
  if (roster.version !== 1 || roster.purpose !== PURPOSE ||
      roster.environment !== 'isolated-local-development') refuse();
  targetMatches(roster.target);
  if (!Number.isSafeInteger(roster.serial) || roster.serial < independentlyKnownMinSerial ||
      !Array.isArray(roster.authorities) || roster.authorities.length < 2 ||
      roster.authorities.length > 8) refuse();
  const issued = date(roster.issuedAt);
  const expires = date(roster.expiresAt);
  if (issued > now || now >= expires || expires <= issued || expires-issued > 24*60*60*1000) refuse();
  const keys = new Map();
  const seen = new Set([independentRootFingerprint]);
  for (const item of roster.authorities) {
    exact(item,['keyId','role','status','publicKeyPem','fingerprint','notBefore','notAfter']);
    id(item.keyId);
    if (!['pilot-signer','independent-reviewer'].includes(item.role) ||
        !['active','revoked'].includes(item.status)) refuse();
    sha(item.fingerprint);
    const from = date(item.notBefore), until = date(item.notAfter);
    if (from >= until || keys.has(item.keyId) || seen.has(item.fingerprint)) refuse();
    const parsedKey = trustedPublicKeyFingerprint(item.publicKeyPem);
    if (parsedKey.hash !== item.fingerprint) refuse();
    seen.add(item.fingerprint);
    keys.set(item.keyId, Object.freeze({ ...item, publicKey: parsedKey.key,
      validNow: from <= now && now < until }));
  }
  // Signatures cover every byte of the canonical immutable roster, including
  // revoked records and the current serial. No self-signed root accepted.
  verify(root.key, ROSTER_DOMAIN, roster, envelope.signature);
  return Object.freeze({ roster, keys, registrySha256: hash(rawRegistry),
    serial: roster.serial, verifiedGovernanceSignature: true, reviewOnly: true });
}

/**
 * Both the pilot signer and a DIFFERENT independent reviewer must be named in
 * a root-signed roster. The reviewer signs a digest of the exact 2F2I envelope
 * plus the roster digest and serial. This remains NON-OPERATIONAL review only.
 */
export function assessTwoPersonPilotReview({
  rawRegistry, rootPublicPem, pinnedRootFingerprint, minimumSerial,
  rawApproval, rawReviewerAttestation, now = Date.now(),
}) {
  const trust = verifySignedTrustRoster(rawRegistry,rootPublicPem,
    pinnedRootFingerprint,minimumSerial,now);
  const envelope = parse(rawReviewerAttestation);
  exact(envelope,['format','review','signature']);
  if (envelope.format !== REVIEW_FORMAT) refuse();
  const review = envelope.review;
  exact(review,['reviewId','signerKeyId','reviewerKeyId','registrySerial',
    'registrySha256','approvalSha256','decision','reviewedAt','expiresAt']);
  const signerId = id(review.signerKeyId), reviewerId = id(review.reviewerKeyId);
  if (signerId === reviewerId || review.registrySerial !== trust.serial ||
      sha(review.registrySha256) !== trust.registrySha256 ||
      sha(review.approvalSha256) !== hash(rawApproval) ||
      review.decision !== 'review-only-confirmed' ||
      typeof review.reviewId !== 'string' || !/^PM-[A-Z0-9]{4,32}$/.test(review.reviewId)) refuse();
  const signer = trust.keys.get(signerId), reviewer = trust.keys.get(reviewerId);
  if (!signer || !reviewer || signer.role !== 'pilot-signer' ||
      reviewer.role !== 'independent-reviewer' ||
      signer.status !== 'active' || reviewer.status !== 'active' ||
      !signer.validNow || !reviewer.validNow ||
      signer.fingerprint === reviewer.fingerprint) refuse();
  const issued = date(review.reviewedAt), expires = date(review.expiresAt);
  if (issued > now || expires <= now || issued >= expires ||
      expires-issued > 60*60*1000 || issued < date(trust.roster.issuedAt) ||
      expires > date(trust.roster.expiresAt)) refuse();
  const approved = verifySignedPilotApproval(rawApproval,signer.publicKeyPem,
    signer.fingerprint,now);
  const raw = parse(rawApproval);
  const proposalIssued = date(raw.manifest.issuedAt);
  // Checking a key's validity only at review time is insufficient: a formerly
  // unauthorized key must not be legitimized retroactively by a later roster.
  // Timestamps are declared/signed facts, not an independent timestamp service.
  if (raw.manifest.approval.reviewId !== review.reviewId ||
      raw.manifest.approval.reviewer !== reviewerId ||
      proposalIssued < date(trust.roster.issuedAt) ||
      proposalIssued < date(signer.notBefore) ||
      proposalIssued >= date(signer.notAfter) ||
      issued < date(reviewer.notBefore) || issued >= date(reviewer.notAfter) ||
      issued < proposalIssued || expires > date(raw.manifest.expiresAt)) refuse();
  verify(reviewer.publicKey,REVIEW_DOMAIN,review,envelope.signature);
  // No evidence can be promoted to runtime authorization through this API.
  // Distinct keys do not prove distinct humans, employment, or approved custody.
  return Object.freeze({ governanceSignatureVerified: true, proposalSignatureVerified: true,
    independentReviewSignatureVerified: true, distinctAuthorityKeys: true,
    serialFloorSatisfied: true, reviewOnly: true, operationalAuthorization: false,
    liveDatabaseAttested: false, realWorldSignerApproved: false });
}

export const GOVERNANCE_PURPOSE = PURPOSE;
export const GOVERNANCE_ROSTER_DOMAIN = ROSTER_DOMAIN;
export const GOVERNANCE_REVIEW_DOMAIN = REVIEW_DOMAIN;
export const GOVERNANCE_ROSTER_FORMAT = REGISTRY_FORMAT;
export const GOVERNANCE_REVIEW_FORMAT = REVIEW_FORMAT;
