/**
 * Phase 2E3C5D11 — strict, offline machine credential receipt contract.
 *
 * This module never contacts the network or accepts an arbitrary server URL.
 * Callers MUST independently verify TLS, the service origin, and the exact
 * expected organization/agent before storing an enrollment response.
 */

export interface MachineIdentity {
  readonly organizationId: string;
  readonly agentId: string;
  readonly machineCredential: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64_URL = /^[A-Za-z0-9_-]{43}$/;

export function isCanonicalMachineSecret(value: unknown): value is string {
  if (typeof value !== 'string' || !B64_URL.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Exact shape from the enrollment redemption handler. Unknown fields are
 * refused, including client-supplied scopes, role, password or SSH details.
 * Error messages never echo the response or credential.
 */
export function parseMachineIdentity(value: unknown): MachineIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid machine enrollment response');
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  if (keys.length !== 3 || keys.join(',') !== 'agentId,machineCredential,organizationId' ||
      !validUuid(fields.organizationId) || !validUuid(fields.agentId) ||
      !isCanonicalMachineSecret(fields.machineCredential)) {
    throw new TypeError('Invalid machine enrollment response');
  }
  return Object.freeze({
    organizationId: fields.organizationId,
    agentId: fields.agentId,
    machineCredential: fields.machineCredential,
  });
}

export function assertExpectedMachineIdentity(
  receipt: MachineIdentity,
  expected: { organizationId: string; agentId: string },
): void {
  if (!validUuid(expected.organizationId) || !validUuid(expected.agentId) ||
      receipt.organizationId !== expected.organizationId ||
      receipt.agentId !== expected.agentId) {
    throw new TypeError('Machine identity does not match expected enrollment');
  }
}
