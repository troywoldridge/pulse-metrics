/**
 * Pulse Metrics D15C-5U-1 — guarded, single-shot LOCAL DEVELOPMENT composition.
 *
 * NOT A CLI, NOT AN AUTOMATIC AGENT SERVICE, NOT PRODUCTION APPROVED.
 * Does not mount any API, open any listener, enroll or create credentials,
 * install migrations, access PostgreSQL, or automatically retry a submission.
 *
 * A trusted operator must already have obtained the exact expected agent and
 * organization UUIDs independently and installed the machine credential in
 * the owner-only local vault. This code refuses to derive tenant ownership
 * from the credential receipt or from a caller-supplied telemetry payload.
 *
 * Only a literal verified HTTPS loopback origin with an explicit port is
 * accepted. The injected fetch MUST perform normal TLS CA/hostname checking.
 */
import { randomUUID } from 'node:crypto';
import { LinuxTelemetryCollector } from '../linux-collector.js';
import { validateTelemetryEnvelope } from '../telemetry-contract.js';
import { readMachineCredential } from '../security/credential-vault.js';
import { assertExpectedMachineIdentity } from '../security/machine-identity.js';
import {
  createHttpsTelemetrySender,
  type TelemetryDeliveryOutcome,
  type TelemetryFetch,
} from './https-telemetry-sender.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type LocalDevOneShotErrorCode =
  | 'disabled'
  | 'invalid_configuration'
  | 'credential_unavailable'
  | 'identity_mismatch'
  | 'collection_unavailable';

const MESSAGES: Record<LocalDevOneShotErrorCode, string> = {
  disabled: 'Local development telemetry delivery is disabled',
  invalid_configuration: 'Local development telemetry configuration rejected',
  credential_unavailable: 'Local machine credential unavailable',
  identity_mismatch: 'Local machine identity does not match expected enrollment',
  collection_unavailable: 'Local Linux telemetry collection unavailable',
};

export class LocalDevOneShotError extends Error {
  constructor(readonly code: LocalDevOneShotErrorCode) {
    super(MESSAGES[code]);
    this.name = 'LocalDevOneShotError';
  }
}

export interface LocalDevOneShotOptions {
  /** Explicit operator confirmation; never infer tenant from this client. */
  readonly expectedOrganizationId: string;
  readonly expectedAgentId: string;
  /** Protected 0700 credential directory, not the file or secret itself. */
  readonly credentialDirectory: string;
  /** Only https://127.0.0.1:<non-privileged-port> is accepted. */
  readonly origin: string;
  /** Provide globalThis.fetch for actual TLS verification; tests may inject a fake. */
  readonly fetchImpl: TelemetryFetch;
  readonly timeoutMs?: number;
}

export interface LocalDevOneShotReceipt {
  readonly status: TelemetryDeliveryOutcome;
  readonly submissionId: string;
  readonly sampleCount: number;
}

function reject(code: LocalDevOneShotErrorCode): never {
  throw new LocalDevOneShotError(code);
}

function checkConfig(options: LocalDevOneShotOptions): void {
  if (process.platform !== 'linux' ||
      process.env.NODE_ENV === 'production' ||
      process.env.PULSE_D15C5U_LOCAL_ONLY !== 'YES' ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') reject('disabled');

  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => ![
        'expectedOrganizationId', 'expectedAgentId', 'credentialDirectory',
        'origin', 'fetchImpl', 'timeoutMs',
      ].includes(key)) ||
      !UUID.test(options.expectedOrganizationId) ||
      !UUID.test(options.expectedAgentId) ||
      typeof options.credentialDirectory !== 'string' ||
      typeof options.fetchImpl !== 'function' ||
      typeof options.origin !== 'string') reject('invalid_configuration');

  // Intentionally stricter than the general HTTPS sender. This candidate
  // must never send to a remote server or even a loopback DNS alias.
  let parsed: URL;
  try { parsed = new URL(options.origin); }
  catch { reject('invalid_configuration'); }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'https:' || parsed.hostname !== '127.0.0.1' ||
      parsed.origin !== options.origin ||
      parsed.pathname !== '/' || parsed.search || parsed.hash ||
      parsed.username || parsed.password ||
      !Number.isInteger(port) || port < 1024 || port > 65535) {
    reject('invalid_configuration');
  }
}

/**
 * Performs ONE collection and ONE delivery. Never persists or prints a secret,
 * retries a failed delivery, or infers a target organization from the vault.
 *
 * A timeout or lost HTTP response can leave the server-side outcome unknown;
 * this is not a durable queue and must not be used as an always-on agent.
 */
export async function deliverLocalDevelopmentSampleOnce(
  options: LocalDevOneShotOptions,
): Promise<LocalDevOneShotReceipt> {
  checkConfig(options);

  // Validate transport configuration before touching the protected vault.
  const sender = createHttpsTelemetrySender({
    origin: options.origin,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  let credential: Awaited<ReturnType<typeof readMachineCredential>>;
  try { credential = await readMachineCredential(options.credentialDirectory); }
  catch { reject('credential_unavailable'); }

  try {
    assertExpectedMachineIdentity(credential, {
      organizationId: options.expectedOrganizationId,
      agentId: options.expectedAgentId,
    });
  } catch { reject('identity_mismatch'); }

  let envelope: Awaited<ReturnType<LinuxTelemetryCollector['collect']>>;
  try {
    envelope = await new LinuxTelemetryCollector().collect();
    if (!validateTelemetryEnvelope(envelope) || envelope.samples.length === 0) {
      reject('collection_unavailable');
    }
  } catch { reject('collection_unavailable'); }

  const submissionId = randomUUID();
  // Preserve the generated ID within this attempt; no automatic retry.
  const status = await sender.send({
    machineCredential: credential.machineCredential,
    submissionId,
    envelope,
  });

  return Object.freeze({ status, submissionId, sampleCount: envelope.samples.length });
}
