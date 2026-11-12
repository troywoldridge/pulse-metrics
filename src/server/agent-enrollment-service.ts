/**
 * Phase 2E3C5D8 — provider-independent enrollment business boundary.
 *
 * UNMOUNTED: this module never opens a PostgreSQL connection and does not
 * supply a live database adapter. The adapter is injected for review/testing;
 * public activation requires a separately approved, versioned migration,
 * verified transport policy, abuse protection and deployment review.
 */
import {
  createAgentSecretMaterial,
  createEnrollmentMaterial,
  hashAgentSecret,
  isCanonicalSecret,
  isValidOrganizationId,
  isVerifiedActor,
  parseAgentDescription,
  type AgentDescription,
} from './agent-credential-policy.js';

export interface EnrollmentIssueRecord {
  readonly subject: string;
  readonly organizationId: string;
  readonly label: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly expiresAt: string;
}

export interface EnrollmentRedeemRecord {
  readonly enrollmentHash: string;
  readonly credentialHash: string;
  readonly credentialPrefix: string;
  readonly agent: AgentDescription;
}

export interface EnrollmentGateway {
  /** Authorize verified WorkOS subject against PostgreSQL membership/role. */
  issue(record: EnrollmentIssueRecord): Promise<string>;
  /** Atomically lock/consume token and issue machine credential in PostgreSQL. */
  redeem(record: EnrollmentRedeemRecord): Promise<{
    organizationId: string;
    agentId: string;
  } | null>;
}

export interface VerifiedActor {
  provider: 'workos';
  subject: string;
  sessionId: string;
}

export class EnrollmentPermissionDenied extends Error {
  constructor() { super('Enrollment permission denied'); }
}
export class EnrollmentNotAvailable extends Error {
  constructor() { super('Enrollment not available'); }
}

function validLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 &&
    value.trim().length >= 1 && !/[\x00-\x1f\x7f]/.test(value);
}

export function parseEnrollmentLabel(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 1 || keys[0] !== 'label' || !validLabel(fields.label)) return null;
  return (fields.label as string).trim();
}

export function parseRedemptionBody(body: unknown): { token: string; agent: AgentDescription } | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  if (keys.length !== 2 || keys[0] !== 'agent' || keys[1] !== 'token' ||
      !isCanonicalSecret(fields.token)) return null;
  const agent = parseAgentDescription(fields.agent);
  return agent ? { token: fields.token, agent } : null;
}

/** A fresh secret is generated on the server; client cannot choose machine credentials. */
export function createAgentEnrollmentService(gateway: EnrollmentGateway) {
  if (!gateway || typeof gateway.issue !== 'function' || typeof gateway.redeem !== 'function') {
    throw new TypeError('An explicit approved enrollment gateway is required');
  }
  return {
    async issue(identity: VerifiedActor, organizationId: string, label: string) {
      if (!isVerifiedActor(identity) || !isValidOrganizationId(organizationId) || !validLabel(label)) {
        throw new TypeError('Invalid enrollment issue request');
      }
      const material = createEnrollmentMaterial();
      const enrollmentId = await gateway.issue({
        subject: identity.subject,
        organizationId,
        label: label.trim(),
        tokenHash: material.tokenHash,
        tokenPrefix: material.tokenPrefix,
        expiresAt: material.expiresAt,
      });
      if (!isValidOrganizationId(enrollmentId)) {
        throw new Error('Unexpected issuance result');
      }
      return {
        enrollmentId,
        organizationId,
        expiresAt: material.expiresAt,
        oneTimeToken: material.oneTimeSecret,
      };
    },
    async redeem(token: string, agent: AgentDescription) {
      if (!isCanonicalSecret(token) || !parseAgentDescription(agent)) {
        throw new TypeError('Invalid enrollment redemption request');
      }
      const machine = createAgentSecretMaterial();
      const result = await gateway.redeem({
        enrollmentHash: hashAgentSecret(token),
        credentialHash: machine.tokenHash,
        credentialPrefix: machine.tokenPrefix,
        agent,
      });
      if (!result) throw new EnrollmentNotAvailable();
      if (!isValidOrganizationId(result.organizationId) || !isValidOrganizationId(result.agentId)) {
        throw new Error('Unexpected redemption result');
      }
      return {
        organizationId: result.organizationId,
        agentId: result.agentId,
        machineCredential: machine.oneTimeSecret,
      };
    },
  };
}

export type AgentEnrollmentService = ReturnType<typeof createAgentEnrollmentService>;
