/**
 * D15C-5P — bounded, same-origin organization discovery for local preview.
 * This is UI input, never authorization. Server-side membership/RLS control
 * every history request independently. Tokens never enter URLs or storage.
 */
import type { HistoryFetcher } from './history-client.js';

export interface PreviewOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: 'owner' | 'admin' | 'member' | 'viewer';
}

export type PreviewOrganizationRead =
  | { readonly ok: true; readonly organizations: readonly PreviewOrganization[] }
  | { readonly ok: false; readonly reason: 'authentication_required' | 'unavailable' | 'invalid_response' };

export interface PreviewOrganizationOptions {
  readonly getAccessToken: () => Promise<string | null>;
  readonly signal?: AbortSignal;
  readonly fetcher?: HistoryFetcher;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLES = new Set(['owner', 'admin', 'member', 'viewer']);
const MAX_ORGANIZATIONS = 50;
const MAX_RESPONSE_BYTES = 48_000;

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}

/** Reject malformed and unexpected identity fields before offering a selector. */
export function parsePreviewOrganizations(value: unknown): readonly PreviewOrganization[] | null {
  if (!plain(value) || !exact(value, ['organizations']) ||
      !Array.isArray(value.organizations) || value.organizations.length > MAX_ORGANIZATIONS) return null;
  const seen = new Set<string>();
  for (const entry of value.organizations) {
    if (!plain(entry) || !exact(entry, ['id', 'name', 'slug', 'role']) ||
        typeof entry.id !== 'string' || !UUID.test(entry.id) || seen.has(entry.id) ||
        typeof entry.name !== 'string' || entry.name.length < 1 || entry.name.length > 160 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(entry.name) ||
        typeof entry.slug !== 'string' || entry.slug.length < 1 || entry.slug.length > 80 ||
        !SLUG.test(entry.slug) ||
        typeof entry.role !== 'string' || !ROLES.has(entry.role)) return null;
    seen.add(entry.id);
  }
  return value.organizations as PreviewOrganization[];
}

export function validPreviewAgentId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Even if a browser changes selectors, the real API still denies strangers. */
export function canRequestPreviewHistory(
  organizationId: string,
  agentId: string,
  authorizedOrganizations: readonly PreviewOrganization[],
): boolean {
  return validPreviewAgentId(agentId) && UUID.test(organizationId) &&
    authorizedOrganizations.some(org => org.id === organizationId);
}

async function boundedJson(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(type)) {
    throw new Error('invalid_json_media_type');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new Error('invalid_content_length');
  }
  if (!response.body) throw new Error('missing_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('oversized_json');
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function readPreviewOrganizations(
  options: PreviewOrganizationOptions,
): Promise<PreviewOrganizationRead> {
  if (!options || typeof options.getAccessToken !== 'function' || options.signal?.aborted) {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const token = await options.getAccessToken();
    if (!token || typeof token !== 'string' || !ACCESS_TOKEN.test(token) || token.length > 16_384) {
      return { ok: false, reason: 'authentication_required' };
    }
    if (options.signal?.aborted) return { ok: false, reason: 'unavailable' };
    const response = await (options.fetcher ?? fetch)('/api/organizations', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: options.signal,
    });
    if (response.status === 401) return { ok: false, reason: 'authentication_required' };
    if (response.status !== 200) return { ok: false, reason: 'unavailable' };
    const data = parsePreviewOrganizations(await boundedJson(response));
    return data === null
      ? { ok: false, reason: 'invalid_response' }
      : { ok: true, organizations: data };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
