/**
 * Pulse Metrics D12 — verified HTTPS enrollment redemption TRANSPORT.
 *
 * This is an unmounted, explicitly invoked client primitive. It never runs
 * from the Linux collector, does not read environment variables and will not
 * print raw enrollment or machine credentials. No retries and no redirects:
 * a one-time enrollment may already have been consumed on a failed response.
 *
 * Node's HTTPS stack performs normal trusted-CA and hostname verification.
 * `trustedCaPem` is an explicit operator-provided trust anchor (staging/private
 * PKI only), never a bypass. `rejectUnauthorized: true` is unconditional.
 */
import { request as httpsRequest } from 'node:https';
import { isCanonicalMachineSecret, parseMachineIdentity, type MachineIdentity } from '../security/machine-identity.js';
import { parseAgentDescription, type AgentDescription } from '../../server/agent-credential-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_BYTES = 1024;
const PATH = '/api/agent-enrollments/redeem';

export class AgentHttpsEnrollmentError extends Error {
  constructor() { super('Verified HTTPS agent enrollment unavailable'); }
}

export interface HttpsEnrollmentRequest {
  /** Exactly an HTTPS ORIGIN such as https://monitor.example.com (no path). */
  readonly expectedOrigin: string;
  /** One-time secret from a separately approved channel, not argv/env/URL. */
  readonly oneTimeToken: string;
  readonly agent: AgentDescription;
  readonly expectedOrganizationId: string;
  /** Optional prior authorization check; required for safe vault installation. */
  readonly expectedAgentId?: string;
  /** Private PKI trust, operator reviewed. Do not use for arbitrary remote hosts. */
  readonly trustedCaPem?: string;
  readonly timeoutMs?: number;
}

function fail(): never { throw new AgentHttpsEnrollmentError(); }

function origin(value: unknown): URL {
  if (typeof value !== 'string' || value.length < 9 || value.length > 512 ||
      /[\x00-\x20\x7f]/.test(value)) fail();
  let parsed: URL;
  try { parsed = new URL(value); } catch { fail(); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/' || !parsed.hostname || parsed.hostname.length > 253) fail();
  return parsed;
}

function isNoStore(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().split(',')
    .some(part => part.trim() === 'no-store');
}

function validate(options: HttpsEnrollmentRequest): {
  url: URL; payload: string; timeout: number; ca: string | undefined;
} {
  if (!options || typeof options !== 'object') fail();
  const base = origin(options.expectedOrigin);
  if (!isCanonicalMachineSecret(options.oneTimeToken) ||
      !UUID.test(options.expectedOrganizationId ?? '') ||
      (options.expectedAgentId !== undefined && !UUID.test(options.expectedAgentId))) fail();
  const agent = parseAgentDescription(options.agent);
  if (!agent) fail();
  const timeout = options.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 15000) fail();
  const ca = options.trustedCaPem;
  if (ca !== undefined && (typeof ca !== 'string' ||
      ca.length < 64 || ca.length > 16384 || !ca.includes('-----BEGIN CERTIFICATE-----') ||
      !ca.includes('-----END CERTIFICATE-----'))) fail();
  const url = new URL(PATH, base);
  const payload = JSON.stringify({ token: options.oneTimeToken, agent });
  if (Buffer.byteLength(payload, 'utf8') > 1024) fail();
  return { url, payload, timeout, ca };
}

/**
 * Returns a machine credential ONLY in process memory. The caller must
 * independently confirm the returned agent ID before saving it to disk.
 */
export async function redeemEnrollmentOverVerifiedHttps(
  options: HttpsEnrollmentRequest,
): Promise<MachineIdentity> {
  let input: ReturnType<typeof validate>;
  try { input = validate(options); } catch { fail(); }
  return new Promise<MachineIdentity>((resolve, reject) => {
    let settled = false;
    const deny = () => {
      if (settled) return;
      settled = true;
      reject(new AgentHttpsEnrollmentError());
    };
    const accept = (receipt: MachineIdentity) => {
      if (settled) return;
      settled = true;
      resolve(receipt);
    };
    let req: ReturnType<typeof httpsRequest>;
    try {
      req = httpsRequest(input.url, {
        method: 'POST',
        agent: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ...(input.ca === undefined ? {} : { ca: input.ca }),
        signal: AbortSignal.timeout(input.timeout),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-store',
          'Connection': 'close',
          'Content-Length': Buffer.byteLength(input.payload, 'utf8'),
        },
      }, response => {
        // An HTTPS redirect never transfers the enrollment secret elsewhere.
        const type = response.headers['content-type'];
        const encoding = response.headers['content-encoding'];
        const length = response.headers['content-length'];
        if (response.statusCode !== 201 || typeof type !== 'string' ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type) ||
            !isNoStore(response.headers['cache-control']) ||
            (encoding !== undefined && encoding !== 'identity') ||
            (length !== undefined && (!/^\d+$/.test(length) || Number(length) > RESPONSE_BYTES))) {
          response.resume();
          deny();
          return;
        }
        const parts: Buffer[] = [];
        let size = 0;
        response.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > RESPONSE_BYTES) {
            deny();
            response.destroy();
            return;
          }
          parts.push(buffer);
        });
        response.once('aborted', deny);
        response.once('error', deny);
        response.once('end', () => {
          if (settled || size < 1) { deny(); return; }
          try {
            const data: unknown = JSON.parse(Buffer.concat(parts, size).toString('utf8'));
            const receipt = parseMachineIdentity(data);
            if (receipt.organizationId !== options.expectedOrganizationId ||
                (options.expectedAgentId !== undefined &&
                 receipt.agentId !== options.expectedAgentId)) { deny(); return; }
            accept(receipt);
          } catch { deny(); }
        });
      });
    } catch { deny(); return; }
    req.once('error', deny);
    req.setTimeout(input.timeout, () => req.destroy());
    req.end(input.payload);
  });
}
