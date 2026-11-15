/** D15C-5Q — bounded, same-origin authorized agent picker client. */
import { isAgentUuid, parseAgentListResponse, type AgentListResponse } from '../server/monitoring/agent-list-contract.js';
import type { HistoryFetcher } from './history-client.js';
import type { PreviewOrganization } from './preview-organization-client.js';

export type PreviewAgentRead =
  | { readonly ok: true; readonly data: AgentListResponse }
  | { readonly ok: false; readonly reason: 'authentication_required' | 'access_denied' | 'unavailable' | 'invalid_response' };

export interface PreviewAgentOptions {
  readonly organizationId: string;
  readonly authorizedOrganizations: readonly PreviewOrganization[];
  readonly getAccessToken: () => Promise<string | null>;
  readonly signal?: AbortSignal;
  readonly fetcher?: HistoryFetcher;
}

const TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const MAX_BYTES = 40_000;

async function readBounded(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('Unexpected media type');
  }
  const announced = response.headers.get('content-length');
  if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > MAX_BYTES)) {
    throw new Error('Unexpected content length');
  }
  if (!response.body) throw new Error('Missing body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_BYTES) throw new Error('Oversized response');
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}

export async function readPreviewAgents(options: PreviewAgentOptions): Promise<PreviewAgentRead> {
  if (!options || !isAgentUuid(options.organizationId) ||
      !Array.isArray(options.authorizedOrganizations) ||
      !options.authorizedOrganizations.some(org => org.id === options.organizationId) ||
      typeof options.getAccessToken !== 'function' || options.signal?.aborted) {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const token = await options.getAccessToken();
    if (!token || typeof token !== 'string' || !TOKEN.test(token) || token.length > 16_384) {
      return { ok: false, reason: 'authentication_required' };
    }
    if (options.signal?.aborted) return { ok: false, reason: 'unavailable' };
    const response = await (options.fetcher ?? fetch)(
      `/api/organizations/${options.organizationId}/agents`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'omit', cache: 'no-store', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: options.signal,
      });
    if (response.status === 401) return { ok: false, reason: 'authentication_required' };
    if (response.status === 403) return { ok: false, reason: 'access_denied' };
    if (response.status !== 200) return { ok: false, reason: 'unavailable' };
    const parsed = parseAgentListResponse(await readBounded(response), options.organizationId);
    return parsed ? { ok: true, data: parsed } : { ok: false, reason: 'invalid_response' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
