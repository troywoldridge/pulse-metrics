/**
 * Phase 2E3C5D7 — pure, provider-independent agent enrollment material.
 * Unmounted foundation: no HTTP handler, database connection or credential transport.
 * A one-time raw secret is returned to its authorized recipient ONLY by a future API.
 */
import { createHash, randomBytes } from 'node:crypto';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^user_[A-Za-z0-9_-]+$/;
export const ENROLLMENT_LIFETIME_MS = 10 * 60_000;

export interface TokenMaterial {
  /** Never log, persist, put in a URL or return except once over verified TLS. */
  readonly oneTimeSecret: string;
  /** Store this SHA-256 digest in PostgreSQL, never the raw secret. */
  readonly tokenHash: string;
  /** Non-secret display prefix derived from the DIGEST, not the raw secret. */
  readonly tokenPrefix: string;
}

export function isCanonicalSecret(value: unknown): value is string {
  if (typeof value !== 'string' || !TOKEN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

export function hashAgentSecret(secret: unknown): string {
  if (!isCanonicalSecret(secret)) throw new TypeError('Invalid agent secret format');
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function createAgentSecretMaterial(): TokenMaterial {
  const oneTimeSecret = randomBytes(32).toString('base64url');
  const tokenHash = hashAgentSecret(oneTimeSecret);
  return Object.freeze({ oneTimeSecret, tokenHash, tokenPrefix: tokenHash.slice(0, 12) });
}

export function createEnrollmentMaterial(nowMs: number = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
      nowMs > 8_640_000_000_000_000 - ENROLLMENT_LIFETIME_MS) {
    throw new TypeError('Invalid enrollment time');
  }
  return Object.freeze({ ...createAgentSecretMaterial(), expiresAt: new Date(nowMs + ENROLLMENT_LIFETIME_MS).toISOString() });
}

/** This validates shape only; server-side authorization is done by PostgreSQL. */
export function isVerifiedActor(value: unknown): value is { provider: 'workos'; subject: string; sessionId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.provider === 'workos' && typeof v.subject === 'string' && v.subject.length <= 255 && SUBJECT.test(v.subject) &&
    typeof v.sessionId === 'string' && v.sessionId.length > 0 && v.sessionId.length <= 4096;
}

export function isValidOrganizationId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export interface AgentDescription {
  displayName: string;
  hostname: string;
  platform: 'linux';
  architecture: 'x86_64' | 'aarch64';
}

export function parseAgentDescription(input: unknown): AgentDescription | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'architecture,displayName,hostname,platform' ||
      typeof v.displayName !== 'string' || v.displayName.trim().length < 1 || v.displayName.length > 120 ||
      /[\x00-\x1f\x7f]/.test(v.displayName) ||
      typeof v.hostname !== 'string' || v.hostname.length > 255 ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(v.hostname) ||
      v.platform !== 'linux' || (v.architecture !== 'x86_64' && v.architecture !== 'aarch64')) return null;
  return { displayName: v.displayName.trim(), hostname: v.hostname, platform: 'linux', architecture: v.architecture };
}
