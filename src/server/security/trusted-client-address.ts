import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

/** No raw forwarding header or untrusted client IP is ever logged here. */
export class UntrustedClientAddressError extends Error {
  constructor() { super('Unable to establish a trusted client network address.'); }
}

export interface TrustedProxyPolicy {
  readonly contains: (address: string) => boolean;
}

/** Canonicalization is essential: equivalent IPv6 spellings must share a quota. */
export function canonicalClientAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 128 ||
      value !== value.trim()) throw new UntrustedClientAddressError();
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) throw new UntrustedClientAddressError();
  try {
    const host = new URL(`http://[${value}]/`).hostname;
    if (!host.startsWith('[') || !host.endsWith(']')) throw Error('bad host');
    const normalized = host.slice(1, -1);
    // Canonical IPv4-mapped IPv6 is equivalent to its IPv4 form, irrespective
    // of whether the upstream supplied dotted-decimal or hexadecimal syntax.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
    if (mapped) {
      const hi = Number.parseInt(mapped[1], 16);
      const lo = Number.parseInt(mapped[2], 16);
      return `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`;
    }
    if (isIP(normalized) !== 6) throw Error('bad normalized IPv6');
    return normalized;
  } catch {
    throw new UntrustedClientAddressError();
  }
}

/** Require an exact, reviewed allowlist of immediate/middle reverse proxies.
 * A wildcard range is never considered explicit trust. Prefer /32 or /128
 * for a local Nginx sidecar rather than trusting whole infrastructure ranges. */
export function parseTrustedProxyCidrs(value: unknown): TrustedProxyPolicy {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new UntrustedClientAddressError();
  }
  const items = value.split(',');
  if (!items.length || items.length > 32) throw new UntrustedClientAddressError();
  const block = new BlockList();
  const seen = new Set<string>();
  try {
    for (const item of items) {
      if (item !== item.trim()) throw Error('Whitespace around CIDR');
      const match = /^([^/\s]+)\/(\d{1,3})$/.exec(item);
      if (!match) throw Error('Invalid CIDR');
      const raw = match[1];
      const ipVersion = isIP(raw);
      const addr = canonicalClientAddress(raw);
      // Mapped IPv4 CIDRs are ambiguous; use IPv4 CIDRs explicitly.
      if (!ipVersion || (ipVersion === 6 && isIP(addr) === 4)) throw Error('Mapped CIDR');
      const prefix = Number(match[2]);
      const bits = ipVersion === 4 ? 32 : 128;
      if (!Number.isInteger(prefix) || prefix <= 0 || prefix > bits) throw Error('Unsafe prefix');
      const key = `${addr}/${prefix}`;
      if (seen.has(key)) throw Error('Duplicate CIDR');
      seen.add(key);
      block.addSubnet(addr, prefix, ipVersion === 4 ? 'ipv4' : 'ipv6');
    }
  } catch {
    throw new UntrustedClientAddressError();
  }
  return {
    contains: (value: string) => {
      try {
        const addr = canonicalClientAddress(value);
        return block.check(addr, isIP(addr) === 4 ? 'ipv4' : 'ipv6');
      } catch { return false; }
    },
  };
}

/**
 * Only a directly trusted socket peer can supply a forwarding chain.
 * Walk X-Forwarded-For from RIGHT to LEFT and select the nearest untrusted
 * hop. Ignore any claims to its left (they may have been injected by a client).
 * If all hops are trusted, no reliable client address exists: fail closed.
 *
 * Deployment requirement: the last trusted proxy MUST append its actual peer
 * address, or replace XFF with its independently verified client address.
 * Prefer Nginx: proxy_set_header X-Forwarded-For $remote_addr;
 */
export function resolveTrustedProxyClientAddress(
  request: Pick<Request, 'socket' | 'headers' | 'rawHeaders'>,
  policy: TrustedProxyPolicy,
): string {
  const peer = canonicalClientAddress(request.socket?.remoteAddress);
  if (!policy.contains(peer)) throw new UntrustedClientAddressError();

  // Reject duplicated forwarding fields rather than letting Node or a proxy
  // silently merge potentially conflicting interpretations.
  const headers = request.rawHeaders;
  if (!Array.isArray(headers) || headers.length % 2 !== 0) throw new UntrustedClientAddressError();
  let count = 0;
  for (let i = 0; i < headers.length; i += 2) {
    if (typeof headers[i] === 'string' && headers[i].toLowerCase() === 'x-forwarded-for') count++;
  }
  if (count !== 1) throw new UntrustedClientAddressError();
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff !== 'string' || !xff.length || xff.length > 1024) {
    throw new UntrustedClientAddressError();
  }
  const parts = xff.split(',');
  if (parts.length < 1 || parts.length > 16) throw new UntrustedClientAddressError();
  const hops = parts.map(part => canonicalClientAddress(part.trim()));
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!policy.contains(hops[i])) return hops[i];
  }
  throw new UntrustedClientAddressError();
}
