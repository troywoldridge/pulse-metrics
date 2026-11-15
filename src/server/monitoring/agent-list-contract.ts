/** D15C-5Q — strict, tenant-bound agent discovery response contract. */
export type ListedAgentStatus = 'pending' | 'active' | 'offline';

export interface ListedAgent {
  readonly id: string;
  readonly displayName: string;
  readonly hostname: string;
  readonly platform: string;
  readonly status: ListedAgentStatus;
  readonly lastSeenAt: string | null;
}

export interface AgentListResponse {
  readonly organizationId: string;
  readonly agents: readonly ListedAgent[];
}

export const MAX_LISTED_AGENTS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['pending', 'active', 'offline']);
const AGENT_KEYS = ['id', 'displayName', 'hostname', 'platform', 'status', 'lastSeenAt'];

export function isAgentUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = Object.getPrototypeOf(value);
  return p === Object.prototype || p === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function label(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function iso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24 || !value.endsWith('Z')) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** Reject unsupported fields and forged tenant/agent status. */
export function parseAgentListResponse(value: unknown, organizationId: string): AgentListResponse | null {
  if (!isAgentUuid(organizationId) || !plain(value) ||
      !exactKeys(value, ['organizationId', 'agents']) ||
      value.organizationId !== organizationId ||
      !Array.isArray(value.agents) || value.agents.length > MAX_LISTED_AGENTS) return null;
  const seen = new Set<string>();
  for (const entry of value.agents) {
    if (!plain(entry) || !exactKeys(entry, AGENT_KEYS) ||
        !isAgentUuid(entry.id) || seen.has(entry.id) ||
        !label(entry.displayName, 120) || !label(entry.hostname, 255) ||
        !label(entry.platform, 40) || !STATUSES.has(entry.status as string) ||
        (entry.lastSeenAt !== null && !iso(entry.lastSeenAt))) return null;
    seen.add(entry.id);
  }
  return value as unknown as AgentListResponse;
}

export function selectListedAgent(
  result: AgentListResponse | null, organizationId: string, agentId: string,
): ListedAgent | null {
  if (!result || result.organizationId !== organizationId || !isAgentUuid(agentId)) return null;
  return result.agents.find(agent => agent.id === agentId) ?? null;
}
