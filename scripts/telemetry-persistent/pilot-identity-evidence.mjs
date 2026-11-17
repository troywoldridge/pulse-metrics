// Pulse Metrics D15C-5U-2F2J — fail-closed identity/membership evidence contract.
// This module is PURE: it cannot connect to PostgreSQL, sign proposals, enroll
// agents, activate a persistent pilot, or turn fixture data into live attestation.
import { verifySignedPilotApproval } from './pilot-authorization-policy.mjs';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PREFIX = 'REFUSE_D15C5U2F2J';
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE = 'pulse-metrics/2f2j/disposable-read-only-identity-v1';

function refuse() { throw new Error(`${PREFIX}: identity evidence or review refused`); }
function record(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o) &&
    Object.getPrototypeOf(o) === Object.prototype;
}
function exact(o, list) {
  if (!record(o) || Object.keys(o).length !== list.length ||
      list.some(k => !Object.hasOwn(o, k))) refuse();
}
function array(o, length) {
  if (!Array.isArray(o) || o.length !== length) refuse();
}
function uuid(s) { if (typeof s !== 'string' || !UUID4.test(s)) refuse(); }
function zero(n) { if (n !== 0) refuse(); }

/**
 * Validate exact, NONSECRET evidence structure. An object provided by a caller
 * is NEVER a database attestation, even when it claims a disposable SQL source.
 * The SQL adapter and its independent lifecycle must also be verified.
 */
export function validatePilotIdentityEvidence(e) {
  exact(e, ['version', 'source', 'target', 'organizations', 'users', 'memberships',
    'agents', 'credentials', 'sampleCount', 'submissionCount', 'security']);
  if (e.version !== 1 || e.source !== SOURCE) refuse();
  exact(e.target, ['database', 'port', 'transport', 'dataDirectoryClass']);
  if (e.target.database !== 'pulse_metrics' || e.target.port !== 55432 ||
      e.target.transport !== 'private-unix-socket-no-tcp' ||
      e.target.dataDirectoryClass !== 'disposable-pulse-replay') refuse();
  array(e.organizations, 1);
  array(e.users, 1);
  array(e.memberships, 1);
  array(e.agents, 1);
  array(e.credentials, 1);
  exact(e.organizations[0], ['id']);
  exact(e.users[0], ['id']);
  exact(e.memberships[0], ['organizationId', 'userId', 'role']);
  exact(e.agents[0], ['organizationId', 'agentId', 'status']);
  exact(e.credentials[0], ['organizationId', 'agentId', 'revoked', 'scopes']);
  const org = e.organizations[0].id;
  const user = e.users[0].id;
  const agent = e.agents[0].agentId;
  uuid(org); uuid(user); uuid(agent);
  uuid(e.memberships[0].organizationId);
  uuid(e.memberships[0].userId);
  uuid(e.agents[0].organizationId);
  uuid(e.credentials[0].organizationId);
  uuid(e.credentials[0].agentId);
  if (e.memberships[0].organizationId !== org ||
      e.memberships[0].userId !== user || e.memberships[0].role !== 'owner' ||
      e.agents[0].organizationId !== org || e.agents[0].status !== 'active' ||
      e.credentials[0].organizationId !== org ||
      e.credentials[0].agentId !== agent || e.credentials[0].revoked !== false ||
      !Array.isArray(e.credentials[0].scopes) ||
      e.credentials[0].scopes.length !== 1 ||
      e.credentials[0].scopes[0] !== 'telemetry:write') refuse();
  // Identity admission is a PRE-TELEMETRY audit. Never relax the signed
  // nonzero (1..100) 2F2I/2F2G telemetry policy to accommodate zero samples.
  zero(e.sampleCount); zero(e.submissionCount);
  exact(e.security, ['rlsViolations', 'unsafeRoles', 'migrationReceiptErrors',
    'unscopedVisibleSamples', 'runtimeCredentialRead', 'runtimeDirectTelemetryInsert']);
  for (const k of ['rlsViolations', 'unsafeRoles', 'migrationReceiptErrors',
    'unscopedVisibleSamples']) zero(e.security[k]);
  if (e.security.runtimeCredentialRead !== false ||
      e.security.runtimeDirectTelemetryInsert !== false) refuse();
  return Object.freeze({ organizationId: org, ownerUserId: user, agentId: agent });
}

export function parseIdentityEvidence(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 16384 ||
      raw.length < 40 || raw.includes('\u0000')) refuse();
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}') || trimmed.includes('\n')) refuse();
  let evidence;
  try { evidence = JSON.parse(trimmed); } catch { refuse(); }
  // SQL-produced JSONB is not itself signed or independently attested.
  // This routine checks exact structure; never infer trusted provenance.
  return { evidence, identity: validatePilotIdentityEvidence(evidence) };
}

/** Offline comparison ONLY. Valid signatures cannot establish DB provenance. */
export function compareSignedIdentityEvidence(rawEnvelope, trustedPublicPem,
  independentlyPinnedFingerprint, evidence, now = Date.now()) {
  const signature = verifySignedPilotApproval(rawEnvelope, trustedPublicPem,
    independentlyPinnedFingerprint, now);
  const actual = validatePilotIdentityEvidence(evidence);
  if (actual.organizationId !== signature.policy.organizationId ||
      actual.agentId !== signature.policy.agentId ||
      actual.ownerUserId !== signature.ownerUserId ||
      signature.policy.agentStatus !== 'active' ||
      signature.policy.expectedSamplesMax > 100) refuse();
  return Object.freeze({ signatureVerified: true, identityContractMatches: true,
    databaseAttested: false, operationalAuthorization: false, reviewOnly: true });
}

export const IDENTITY_EVIDENCE_SOURCE = SOURCE;

// Called ONLY by the restricted disposable adapter, with output from psql.
// Does not print raw owner/agent IDs; structural checks never authorize a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--verify-disposable-stdin') refuse();
    parseIdentityEvidence(readFileSync(0, 'utf8'));
    process.stdout.write('PASS: disposable read-only identity facts match one-owner pretelemetry shape; NO AUTHORIZATION\n');
  } catch {
    process.stderr.write('REFUSE_D15C5U2F2J: read-only identity evidence denied\n');
    process.exitCode = 1;
  }
}
