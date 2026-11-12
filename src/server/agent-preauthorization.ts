/**
 * D13 — pre-authorized, pending Linux agent identity.
 *
 * REVIEW-ONLY. Does not open a DB connection, mount routes, use WorkOS on its
 * own, or enable production. SQL functions independently check membership.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  createAgentSecretMaterial,
  createEnrollmentMaterial,
  hashAgentSecret,
  isCanonicalSecret,
  isSha256Digest,
  isValidOrganizationId,
  isVerifiedActor,
  parseAgentDescription,
  type AgentDescription,
} from './agent-credential-policy.js';
import {
  EnrollmentNotAvailable,
  EnrollmentPermissionDenied,
  type EnrollmentRedeemRecord,
  type VerifiedActor,
} from './agent-enrollment-service.js';

export type PreauthorizedSqlExecutor = (statement: SQL) => Promise<unknown>;

export interface PreauthorizationRecord {
  readonly subject: string;
  readonly organizationId: string;
  readonly label: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly expiresAt: string;
  readonly agent: AgentDescription;
}

export interface PreauthorizedGateway {
  issue(record: PreauthorizationRecord): Promise<{ enrollmentId: string; agentId: string }>;
  redeem(record: EnrollmentRedeemRecord): Promise<{ organizationId: string; agentId: string } | null>;
}

function deny(): never { throw new TypeError('Invalid preauthorized enrollment request'); }

function parseRows(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== 'object' || !('rows' in result) ||
      !Array.isArray(result.rows) || !result.rows.every((r: unknown) =>
        !!r && typeof r === 'object' && !Array.isArray(r))) {
    throw new Error('Unexpected enrollment database response');
  }
  return result.rows as Record<string, unknown>[];
}

function dbState(error: unknown): string | null {
  let current = error;
  for (let i=0; i<4; i++) {
    if (!current || typeof current !== 'object') break;
    const item = current as { code?: unknown; cause?: unknown };
    if (typeof item.code === 'string') return item.code;
    current = item.cause;
  }
  return null;
}

async function run(execute: PreauthorizedSqlExecutor, statement: SQL) {
  try { return parseRows(await execute(statement)); }
  catch (error) {
    if (dbState(error) === '42501') throw new EnrollmentPermissionDenied();
    if (dbState(error) === 'P0002') throw new EnrollmentNotAvailable();
    throw error;
  }
}

function validLabel(label: unknown): label is string {
  return typeof label === 'string' && label.length <= 120 &&
    label.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(label);
}

export function parsePreauthorizationBody(value: unknown):
  { label: string; agent: AgentDescription } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== 'agent,label' ||
      !validLabel(fields.label)) return null;
  const agent = parseAgentDescription(fields.agent);
  return agent ? { label: fields.label.trim(), agent } : null;
}

/** Inject the RESTRICTED app DB executor. This factory never connects by itself. */
export function createPreauthorizedPostgresGateway(execute: PreauthorizedSqlExecutor): PreauthorizedGateway {
  if (typeof execute !== 'function') deny();
  return {
    async issue(record) {
      const agent = parseAgentDescription(record?.agent);
      if (!agent || !isValidOrganizationId(record?.organizationId) ||
          typeof record.subject !== 'string' || !/^user_[A-Za-z0-9_-]+$/.test(record.subject) ||
          record.subject.length > 255 || !validLabel(record.label) ||
          !isSha256Digest(record.tokenHash) || record.tokenPrefix !== record.tokenHash.slice(0,12) ||
          !Number.isFinite(Date.parse(record.expiresAt))) deny();
      const matches = await run(execute, sql`
        SELECT enrollment_id, agent_id FROM pulse_agent_enrollment.issue_preallocated_enrollment(
          ${record.subject}, ${record.organizationId}::uuid, ${record.tokenHash},
          ${record.tokenPrefix}, ${record.label.trim()}, ${record.expiresAt}::timestamptz,
          ${agent.displayName}, ${agent.hostname}, ${agent.platform}, ${agent.architecture})`);
      if (matches.length !== 1 || !isValidOrganizationId(matches[0].enrollment_id) ||
          !isValidOrganizationId(matches[0].agent_id)) {
        throw new Error('Unexpected enrollment database response');
      }
      return { enrollmentId: matches[0].enrollment_id, agentId: matches[0].agent_id };
    },
    async redeem(record) {
      const agent = parseAgentDescription(record?.agent);
      if (!agent || !isSha256Digest(record?.enrollmentHash) ||
          !isSha256Digest(record.credentialHash) ||
          record.credentialHash === record.enrollmentHash ||
          record.credentialPrefix !== record.credentialHash.slice(0,12)) deny();
      const matches = await run(execute, sql`
        SELECT organization_id, agent_id FROM pulse_agent_enrollment.redeem_preallocated_enrollment(
          ${record.enrollmentHash}, ${record.credentialHash}, ${record.credentialPrefix},
          ${agent.displayName}, ${agent.hostname}, ${agent.platform}, ${agent.architecture})`);
      if (matches.length === 0) return null;
      if (matches.length !== 1 || !isValidOrganizationId(matches[0].organization_id) ||
          !isValidOrganizationId(matches[0].agent_id)) {
        throw new Error('Unexpected enrollment database response');
      }
      return { organizationId: matches[0].organization_id, agentId: matches[0].agent_id };
    },
  };
}

/**
 * The authenticated ISSUE response is the independently trusted control-plane
 * source of agentId. Do not copy agentId from a later redemption response.
 * The preauthorized agent description is immutable during redemption.
 */
export function createPreauthorizedEnrollmentService(gateway: PreauthorizedGateway) {
  if (!gateway || typeof gateway.issue !== 'function' || typeof gateway.redeem !== 'function') deny();
  return {
    async issue(actor: VerifiedActor, organizationId: string, label: string, agent: AgentDescription) {
      if (!isVerifiedActor(actor) || !isValidOrganizationId(organizationId) ||
          !validLabel(label) || !parseAgentDescription(agent)) deny();
      const material = createEnrollmentMaterial();
      const issued = await gateway.issue({
        subject: actor.subject, organizationId, label: label.trim(), agent,
        tokenHash: material.tokenHash, tokenPrefix: material.tokenPrefix,
        expiresAt: material.expiresAt,
      });
      if (!issued || !isValidOrganizationId(issued.enrollmentId) ||
          !isValidOrganizationId(issued.agentId)) throw new Error('Unexpected enrollment result');
      return {
        organizationId, enrollmentId: issued.enrollmentId, agentId: issued.agentId,
        expiresAt: material.expiresAt, oneTimeToken: material.oneTimeSecret,
      };
    },
    async redeem(token: string, agent: AgentDescription) {
      if (!isCanonicalSecret(token) || !parseAgentDescription(agent)) deny();
      const credential = createAgentSecretMaterial();
      const redeemed = await gateway.redeem({
        enrollmentHash: hashAgentSecret(token),
        credentialHash: credential.tokenHash, credentialPrefix: credential.tokenPrefix, agent,
      });
      if (!redeemed) throw new EnrollmentNotAvailable();
      if (!isValidOrganizationId(redeemed.organizationId) ||
          !isValidOrganizationId(redeemed.agentId)) throw new Error('Unexpected enrollment result');
      return { organizationId: redeemed.organizationId, agentId: redeemed.agentId,
        machineCredential: credential.oneTimeSecret };
    },
  };
}

export type PreauthorizedEnrollmentService = ReturnType<typeof createPreauthorizedEnrollmentService>;
