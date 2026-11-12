/**
 * D12 opt-in verified HTTPS -> identity check -> D11 owner-only vault.
 *
 * No CLI, no environment switch, no automatic agent startup. The expected
 * agent ID must come from an independent, authenticated control-plane check;
 * it may NOT be copied from the response whose identity it is checking.
 *
 * Enrollment is single-use. If local storage fails after remote redemption,
 * do NOT automatically retry: operator reconciliation/revocation is needed.
 */
import { lstat } from 'node:fs/promises';
import {
  credentialLocation,
  installMachineCredential,
} from '../security/credential-vault.js';
import {
  redeemEnrollmentOverVerifiedHttps,
  AgentHttpsEnrollmentError,
  type HttpsEnrollmentRequest,
} from './https-redemption.js';

export interface VerifiedEnrollmentInstallation extends HttpsEnrollmentRequest {
  readonly expectedAgentId: string;
  readonly credentialDirectory: string;
}

export async function redeemAndInstallVerifiedMachineIdentity(
  request: VerifiedEnrollmentInstallation,
): Promise<{ organizationId: string; agentId: string }> {
  if (!request || typeof request.expectedAgentId !== 'string') {
    throw new AgentHttpsEnrollmentError();
  }
  try {
    // Refuse an existing target before consuming the remote one-time token.
    // This early check is only a usability guard; D11's exclusive lock and
    // owner/permission checks are the final filesystem security boundary.
    const target = credentialLocation(request.credentialDirectory);
    try {
      await lstat(target);
      throw new AgentHttpsEnrollmentError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AgentHttpsEnrollmentError();
      }
    }
    const receipt = await redeemEnrollmentOverVerifiedHttps(request);
    await installMachineCredential(request.credentialDirectory, receipt, {
      organizationId: request.expectedOrganizationId,
      agentId: request.expectedAgentId,
    });
    return { organizationId: receipt.organizationId, agentId: receipt.agentId };
  } catch {
    // Never echo response, filesystem path, raw token, or TLS exception text.
    throw new AgentHttpsEnrollmentError();
  }
}
