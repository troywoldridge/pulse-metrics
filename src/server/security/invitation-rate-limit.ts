import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import type { AuthenticatedIdentity } from '../auth/workos-auth.js';

export type InvitationAction = 'issue' | 'accept';
export type InvitationBucketKind = 'actor' | 'network';
export type RateLimitConsumer = (
  action: InvitationAction,
  kind: InvitationBucketKind,
  digest: string,
) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;

export class InvitationRateLimitUnavailableError extends Error {
  constructor() { super('Invitation rate limiting is unavailable.'); }
}
export class InvitationRateLimitExceededError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('Invitation request rate limited.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const SUBJECT = /^user_[A-Za-z0-9_-]+$/;
const DIGEST = /^[a-f0-9]{64}$/;

/** Does not read forwarded headers. A trusted reverse-proxy policy is required
 * before attaching this to live routes on an internet-facing deployment. */
export function normalizeSocketAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) throw new InvitationRateLimitUnavailableError();
  const address = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (!isIP(address)) throw new InvitationRateLimitUnavailableError();
  return address.toLowerCase();
}

/** A 32-byte secret identical on every API instance, never exposed to clients.
 * Rotation starts new buckets and must be coordinated across all instances. */
export function parseRateLimitHmacKey(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new InvitationRateLimitUnavailableError();
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) {
    throw new InvitationRateLimitUnavailableError();
  }
  return bytes;
}

/** The restricted app role can EXECUTE this function but cannot view counters. */
export async function consumePersistedInvitationBucket(
  action: InvitationAction,
  kind: InvitationBucketKind,
  digest: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const result = await getDatabase().execute(sql`
    SELECT allowed, retry_after_seconds
    FROM public.consume_invitation_rate_limit(${action},${kind},${digest})
  `);
  const row = result.rows[0];
  return {
    allowed: row?.allowed === true,
    retryAfterSeconds: Number(row?.retry_after_seconds),
  };
}

function validateDecision(value: unknown): { allowed: boolean; retryAfterSeconds: number } {
  if (!value || typeof value !== 'object') throw new InvitationRateLimitUnavailableError();
  const data = value as { allowed?: unknown; retryAfterSeconds?: unknown };
  if (typeof data.allowed !== 'boolean' ||
      typeof data.retryAfterSeconds !== 'number' ||
      !Number.isSafeInteger(data.retryAfterSeconds) ||
      data.retryAfterSeconds < 0 || data.retryAfterSeconds > 900 ||
      (data.allowed && data.retryAfterSeconds !== 0) ||
      (!data.allowed && data.retryAfterSeconds === 0)) {
    throw new InvitationRateLimitUnavailableError();
  }
  return { allowed: data.allowed, retryAfterSeconds: data.retryAfterSeconds };
}

/** Network bucket must be checked *before* authentication; actor bucket only
 * after WorkOS middleware has verified a bearer and populated identity.
 * The caller, never this component, chooses response status and safe headers.
 * No token, email, or organization value is ever used in bucket keys. */
export function createInvitationRateLimiter(deps: {
  hmacKey: string;
  consume: RateLimitConsumer;
}) {
  const secret = parseRateLimitHmacKey(deps.hmacKey);

  async function consume(action: InvitationAction, kind: InvitationBucketKind, key: string) {
    if (action !== 'issue' && action !== 'accept') throw new InvitationRateLimitUnavailableError();
    const digest = createHmac('sha256', secret)
      .update(`pulse-invitation-v1\0${action}\0${kind}\0${key}`, 'utf8')
      .digest('hex');
    if (!DIGEST.test(digest)) throw new InvitationRateLimitUnavailableError();
    let decision: { allowed: boolean; retryAfterSeconds: number };
    try {
      decision = validateDecision(await deps.consume(action, kind, digest));
    } catch {
      throw new InvitationRateLimitUnavailableError();
    }
    if (!decision.allowed) throw new InvitationRateLimitExceededError(decision.retryAfterSeconds);
  }

  return {
    /** Use req.socket.remoteAddress, never untrusted X-Forwarded-For. */
    checkNetwork: async (action: InvitationAction, socketAddress: unknown) =>
      consume(action, 'network', normalizeSocketAddress(socketAddress)),
    checkActor: async (action: InvitationAction, identity: AuthenticatedIdentity) => {
      if (!identity || identity.provider !== 'workos' ||
          typeof identity.subject !== 'string' || identity.subject.length > 255 ||
          !SUBJECT.test(identity.subject) ||
          typeof identity.sessionId !== 'string' || identity.sessionId.length === 0) {
        throw new InvitationRateLimitUnavailableError();
      }
      await consume(action, 'actor', identity.subject);
    },
  };
}

/** Production assembly; intentionally NOT imported or mounted by server.ts. */
export function createLiveInvitationRateLimiter(environment: NodeJS.ProcessEnv = process.env) {
  return createInvitationRateLimiter({
    hmacKey: environment.INVITATION_RATE_LIMIT_HMAC_KEY ?? '',
    consume: consumePersistedInvitationBucket,
  });
}
