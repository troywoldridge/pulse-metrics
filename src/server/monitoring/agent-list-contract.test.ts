import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentListResponse, selectListedAgent } from './agent-list-contract.js';

const ORG = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const FOREIGN = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
const AGENT = '3a1b0033-0fd2-4a45-b711-32ef63ce0178';
const entry = { id: AGENT, displayName: 'Development server', hostname: 'local-node', platform: 'linux',
  status: 'pending', lastSeenAt: null } as const;

test('5Q exact response accepts tenant-owned names and honest null last contact', () => {
  const list = parseAgentListResponse({ organizationId: ORG, agents: [entry] }, ORG);
  assert.ok(list);
  assert.deepEqual(selectListedAgent(list, ORG, AGENT), entry);
  assert.equal(selectListedAgent(list, FOREIGN, AGENT), null);
  assert.equal(selectListedAgent(list, ORG, FOREIGN), null);
  assert.deepEqual(parseAgentListResponse({ organizationId: ORG, agents: [] }, ORG)?.agents, []);
});

test('5Q rejects forged tenant, private fields, revoked agents and duplicates', () => {
  for (const value of [
    { organizationId: FOREIGN, agents: [entry] },
    { organizationId: ORG, agents: [entry], userId: 'forged' },
    { organizationId: ORG, agents: [entry, entry] },
    { organizationId: ORG, agents: [{ ...entry, status: 'revoked' }] },
    { organizationId: ORG, agents: [{ ...entry, accessToken: 'secret' }] },
    { organizationId: ORG, agents: [{ ...entry, displayName: '<bad>\u0000' }] },
    { organizationId: ORG, agents: [{ ...entry, id: 'fake' }] },
    { organizationId: ORG, agents: [{ ...entry, lastSeenAt: 'yesterday' }] },
    { organizationId: ORG, agents: Array.from({ length: 51 }, (_, i) => ({
      ...entry, id: `3a1b${String(i).padStart(4, '0')}-0fd2-4a45-b711-32ef63ce0178`,
    })) },
  ]) assert.equal(parseAgentListResponse(value, ORG), null);
});

test('5Q accepts recorded timestamps and refuses invalid date strings', () => {
  const valid = { ...entry, lastSeenAt: '2026-11-15T10:00:00.000Z' };
  assert.ok(parseAgentListResponse({ organizationId: ORG, agents: [valid] }, ORG));
  assert.equal(parseAgentListResponse({ organizationId: ORG,
    agents: [{ ...valid, lastSeenAt: '2026-11-15T10:00:00Z' }] }, ORG), null);
});
