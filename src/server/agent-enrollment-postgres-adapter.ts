/**
 * Pulse Metrics 2E3C5D9 — unmounted production-intent PostgreSQL gateway.
 *
 * This does NOT connect to a database or mount a route on import. The caller
 * explicitly supplies a trusted Drizzle execute function. Never expose this
 * gateway outside a separately approved ingress and WorkOS authorization path.
 *
 * Database security-definer functions independently validate memberships,
 * tenant bindings, one-use tokens and revocation; this gateway never reads
 * sensitive tables or trusts a caller-supplied organization for redemption.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  createAgentSecretMaterial,
  hashAgentSecret,
  isCanonicalSecret,
  isSha256Digest,
  isValidOrganizationId,
  isVerifiedActor,
  parseAgentDescription,
} from './agent-credential-policy.js';
import {
  EnrollmentNotAvailable,
  EnrollmentPermissionDenied,
  type EnrollmentGateway,
  type EnrollmentIssueRecord,
  type EnrollmentRedeemRecord,
  type VerifiedActor,
} from './agent-enrollment-service.js';

/** Caller must inject a real, restricted database query executor. */
export type EnrollmentSqlExecutor = (statement: SQL) => Promise<unknown>;

function rows(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== 'object' ||
      !('rows' in result) || !Array.isArray(result.rows) ||
      !result.rows.every(row => !!row && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error('Unexpected database response');
  }
  return result.rows as Record<string, unknown>[];
}

function sqlState(error: unknown): string | null {
  let node = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!node || typeof node !== 'object') return null;
    const e = node as { code?: unknown; cause?: unknown };
    if (typeof e.code === 'string') return e.code;
    node = e.cause;
  }
  return null;
}

async function run(execute: EnrollmentSqlExecutor, statement: SQL): Promise<Record<string, unknown>[]> {
  try {
    return rows(await execute(statement));
  } catch (error) {
    const state = sqlState(error);
    if (state === '42501') throw new EnrollmentPermissionDenied();
    if (state === 'P0002') throw new EnrollmentNotAvailable();
    // Never log database errors or tokens here; HTTP contracts sanitize them.
    throw error;
  }
}

function correctDigest(value: unknown, prefix: unknown): boolean {
  return isSha256Digest(value) && typeof prefix === 'string' &&
    prefix === value.slice(0, 12);
}

function actorAndTarget(identity: VerifiedActor, organizationId: string, agentId: string): void {
  if (!isVerifiedActor(identity) || !isValidOrganizationId(organizationId) ||
      !isValidOrganizationId(agentId)) {
    throw new TypeError('Invalid verified actor or agent target');
  }
}

/**
 * Only SQL parameter bindings are used. All return shapes are revalidated;
 * no SQL error body or raw token is returned by these helpers.
 */
export function createPostgresEnrollmentGateway(execute: EnrollmentSqlExecutor) {
  if (typeof execute !== 'function') throw new TypeError('Explicit SQL executor required');
  const gateway: EnrollmentGateway = {
    async issue(record: EnrollmentIssueRecord): Promise<string> {
      if (!record || !/^user_[A-Za-z0-9_-]{1,250}$/.test(record.subject) ||
          !isValidOrganizationId(record.organizationId) ||
          !correctDigest(record.tokenHash, record.tokenPrefix) ||
          typeof record.label !== 'string' || record.label.length > 120 ||
          !record.label.trim() || /[\x00-\x1f\x7f]/.test(record.label) ||
          typeof record.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(record.expiresAt))) {
        throw new TypeError('Invalid enrollment database request');
      }
      const result = await run(execute, sql`
        SELECT pulse_agent_enrollment.issue_enrollment(
          ${record.subject}::text, ${record.organizationId}::uuid,
          ${record.tokenHash}::text, ${record.tokenPrefix}::text,
          ${record.label}::text, ${record.expiresAt}::timestamptz
        ) AS enrollment_id
      `);
      if (result.length !== 1 || !isValidOrganizationId(result[0].enrollment_id)) {
        throw new Error('Unexpected enrollment database result');
      }
      return result[0].enrollment_id;
    },
    async redeem(record: EnrollmentRedeemRecord): Promise<{ organizationId: string; agentId: string } | null> {
      if (!record || !isSha256Digest(record.enrollmentHash) ||
          !correctDigest(record.credentialHash, record.credentialPrefix) ||
          record.enrollmentHash === record.credentialHash ||
          !parseAgentDescription(record.agent)) {
        throw new TypeError('Invalid redemption database request');
      }
      const result = await run(execute, sql`
        SELECT organization_id, agent_id
        FROM pulse_agent_enrollment.redeem_enrollment(
          ${record.enrollmentHash}::text, ${record.credentialHash}::text,
          ${record.credentialPrefix}::text, ${record.agent.displayName}::text,
          ${record.agent.hostname}::text, ${record.agent.platform}::text,
          ${record.agent.architecture}::text
        )
      `);
      if (result.length === 0) return null;
      if (result.length !== 1 || !isValidOrganizationId(result[0].organization_id) ||
          !isValidOrganizationId(result[0].agent_id)) {
        throw new Error('Unexpected redemption database result');
      }
      return { organizationId: result[0].organization_id, agentId: result[0].agent_id };
    },
  };

  return {
    ...gateway,
    /** Machine credential never selects its own organization. */
    async verifyMachineCredential(secret: unknown): Promise<{ organizationId: string; agentId: string } | null> {
      if (!isCanonicalSecret(secret)) return null;
      const digest = hashAgentSecret(secret);
      const result = await run(execute, sql`
        SELECT organization_id, agent_id
        FROM pulse_agent_enrollment.verify_credential(${digest}::text)
      `);
      if (result.length === 0) return null;
      if (result.length !== 1 || !isValidOrganizationId(result[0].organization_id) ||
          !isValidOrganizationId(result[0].agent_id)) {
        throw new Error('Unexpected machine credential database result');
      }
      return { organizationId: result[0].organization_id, agentId: result[0].agent_id };
    },
    async revokeAgent(identity: VerifiedActor, organizationId: string, agentId: string): Promise<boolean> {
      actorAndTarget(identity, organizationId, agentId);
      const result = await run(execute, sql`
        SELECT pulse_agent_enrollment.revoke_agent(
          ${identity.subject}::text, ${organizationId}::uuid, ${agentId}::uuid
        ) AS revoked
      `);
      if (result.length !== 1 || typeof result[0].revoked !== 'boolean') {
        throw new Error('Unexpected revocation database result');
      }
      return result[0].revoked;
    },
    async rotateCredential(identity: VerifiedActor, organizationId: string, agentId: string) {
      actorAndTarget(identity, organizationId, agentId);
      const credential = createAgentSecretMaterial();
      const result = await run(execute, sql`
        SELECT pulse_agent_enrollment.rotate_credential(
          ${identity.subject}::text, ${organizationId}::uuid, ${agentId}::uuid,
          ${credential.tokenHash}::text, ${credential.tokenPrefix}::text
        ) AS rotated
      `);
      if (result.length !== 1 || result[0].rotated !== true) {
        throw new Error('Unexpected rotation database result');
      }
      // Return once only; external operator transport remains UNMOUNTED.
      return { organizationId, agentId, machineCredential: credential.oneTimeSecret };
    },
  };
}
