/**
 * Phase 2E3C5D10 — unmounted distributed enrollment quota client.
 * No database access on import; the trusted caller supplies an executor.
 * Never reuse invitation quota actions or send raw identifiers to PostgreSQL.
 */
import { createHmac } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { canonicalClientAddress } from './trusted-client-address.js';
import { isVerifiedActor } from '../agent-credential-policy.js';

type QuotaAction = 'issue' | 'redeem';
type QuotaKind = 'actor' | 'network';
export type AgentQuotaConsumer = (
  action: QuotaAction, kind: QuotaKind, hmacDigest: string,
) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
export type AgentQuotaSqlExecutor = (statement: SQL) => Promise<unknown>;

export class AgentQuotaUnavailable extends Error {
  constructor() { super('Enrollment quota service is unavailable'); }
}
export class AgentQuotaExceeded extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Enrollment quota exceeded');
  }
}

/** Configured independently on each API instance, but identical across instances. */
export function parseAgentQuotaKey(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AgentQuotaUnavailable();
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) {
    throw new AgentQuotaUnavailable();
  }
  return bytes;
}

export function createAgentQuotaLimiter(options: {
  hmacKey: string;
  consume: AgentQuotaConsumer;
}) {
  if (!options || typeof options.consume !== 'function') throw new AgentQuotaUnavailable();
  const key = parseAgentQuotaKey(options.hmacKey);

  async function check(action: QuotaAction, kind: QuotaKind, identifier: string) {
    if (!((action === 'issue' && (kind === 'network' || kind === 'actor')) ||
      (action === 'redeem' && kind === 'network'))) throw new AgentQuotaUnavailable();
    const digest = createHmac('sha256', key)
      .update(`pulse-agent-ingress-v1\0${action}\0${kind}\0${identifier}`)
      .digest('hex');
    try {
      const decision = await options.consume(action, kind, digest);
      if (!decision || typeof decision.allowed !== 'boolean' ||
        !Number.isSafeInteger(decision.retryAfterSeconds) ||
        decision.retryAfterSeconds < 0 || decision.retryAfterSeconds > 900 ||
        (decision.allowed && decision.retryAfterSeconds !== 0) ||
        (!decision.allowed && decision.retryAfterSeconds === 0)) {
        throw new AgentQuotaUnavailable();
      }
      if (!decision.allowed) throw new AgentQuotaExceeded(decision.retryAfterSeconds);
    } catch (error) {
      if (error instanceof AgentQuotaExceeded) throw error;
      throw new AgentQuotaUnavailable();
    }
  }

  return {
    checkNetwork: async (action: QuotaAction, address: unknown) => {
      let canonical: string;
      try { canonical = canonicalClientAddress(address); }
      catch { throw new AgentQuotaUnavailable(); }
      await check(action, 'network', canonical);
    },
    checkActor: async (identity: unknown) => {
      if (!isVerifiedActor(identity)) throw new AgentQuotaUnavailable();
      await check('issue', 'actor', identity.subject);
    },
  };
}

/**
 * Fixed SQL function owned by isolated NOLOGIN executor, callable by restricted
 * runtime role. Raw IP addresses and WorkOS subjects never leave Node as DB keys.
 */
export function createPostgresAgentQuotaConsumer(execute: AgentQuotaSqlExecutor): AgentQuotaConsumer {
  if (typeof execute !== 'function') throw new AgentQuotaUnavailable();
  return async (action, kind, digest) => {
    if (!((action === 'issue' && (kind === 'actor' || kind === 'network')) ||
      (action === 'redeem' && kind === 'network')) ||
      !/^[a-f0-9]{64}$/.test(digest)) throw new AgentQuotaUnavailable();
    try {
      const result = await execute(sql`
        SELECT allowed, retry_after_seconds
        FROM pulse_agent_enrollment.consume_ingress_quota(
          ${action}::text, ${kind}::text, ${digest}::text
        )
      `);
      const rows: unknown = (result as { rows?: unknown } | null)?.rows;
      if (!Array.isArray(rows) || rows.length !== 1 ||
          !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) {
        throw new AgentQuotaUnavailable();
      }
      const row = rows[0] as { allowed?: unknown; retry_after_seconds?: unknown };
      if (typeof row.allowed !== 'boolean' ||
        typeof row.retry_after_seconds !== 'number' ||
        !Number.isSafeInteger(row.retry_after_seconds)) throw new AgentQuotaUnavailable();
      return { allowed: row.allowed, retryAfterSeconds: row.retry_after_seconds };
    } catch {
      throw new AgentQuotaUnavailable();
    }
  };
}
