/** D14 — explicit operator-approved local enrollment composition. */
import { lstat } from 'node:fs/promises';
import { credentialLocation } from '../security/credential-vault.js';
import { isCanonicalMachineSecret } from '../security/machine-identity.js';
import { parseAgentDescription } from '../../server/agent-credential-policy.js';
import {
  redeemAndInstallVerifiedMachineIdentity,
  type VerifiedEnrollmentInstallation,
} from './enrollment-workflow.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OperatorEnrollmentError extends Error {
  constructor() { super('Operator enrollment unavailable; reconcile before retrying'); }
}

export type OperatorEnrollmentRequest = Omit<VerifiedEnrollmentInstallation, 'oneTimeToken'>;

/**
 * Caller must separately obtain both approved IDs from the authenticated
 * owner/admin issuance action. Never use the redemption response to select
 * expectedAgentId. This function does not fetch a token or retry enrollment.
 */
export async function enrollWithOperatorToken(
  options: OperatorEnrollmentRequest,
  readToken: () => Promise<string>,
): Promise<{ organizationId: string; agentId: string }> {
  try {
    if (!options || typeof readToken !== 'function' ||
        !UUID.test(options.expectedOrganizationId) ||
        !UUID.test(options.expectedAgentId) ||
        !parseAgentDescription(options.agent)) throw new OperatorEnrollmentError();

    // Fail before requesting the secret if a credential already exists.
    const target = credentialLocation(options.credentialDirectory);
    try {
      await lstat(target);
      throw new OperatorEnrollmentError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const token = await readToken();
    if (!isCanonicalMachineSecret(token)) throw new OperatorEnrollmentError();
    return await redeemAndInstallVerifiedMachineIdentity({ ...options, oneTimeToken: token });
  } catch {
    // The network may have consumed the one-time token; never auto retry.
    // Error messages intentionally include no token, file path or HTTPS body.
    throw new OperatorEnrollmentError();
  }
}
