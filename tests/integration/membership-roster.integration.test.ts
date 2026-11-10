/**
 * Phase 2E2: real PostgreSQL / HTTP integration for member-roster authorization.
 * Fake verifier inputs are TEST FIXTURES ONLY; the real HTTP route, service,
 * Drizzle connection, restricted DB role, and PostgreSQL RLS are exercised.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { closeDatabase, getDatabase } from '../../src/db/client.js';
import { organizationMemberships } from '../../src/db/schema.js';
import { createMembershipRosterRoute } from '../../src/server/auth/organization-membership-route.js';
import { requireWorkOSUser, type TokenVerifier } from '../../src/server/auth/workos-auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Required test fixture setting missing: ${key}`);
  return value;
}

const orgA = requiredEnv('PULSE_ROSTER_TEST_ORG_A');
const orgB = requiredEnv('PULSE_ROSTER_TEST_ORG_B');
for (const [label, value] of [['orgA', orgA], ['orgB', orgB]]) {
  if (!UUID.test(value)) throw new Error(`${label} fixture is not a UUID`);
}

const subjects: Record<string, string> = {
  'owner-a': requiredEnv('PULSE_ROSTER_TEST_OWNER_A'),
  'admin-a': requiredEnv('PULSE_ROSTER_TEST_ADMIN_A'),
  'member-a': requiredEnv('PULSE_ROSTER_TEST_MEMBER_A'),
  'viewer-a': requiredEnv('PULSE_ROSTER_TEST_VIEWER_A'),
  'owner-b': requiredEnv('PULSE_ROSTER_TEST_OWNER_B'),
  'admin-b': requiredEnv('PULSE_ROSTER_TEST_ADMIN_B'),
  'member-b': requiredEnv('PULSE_ROSTER_TEST_MEMBER_B'),
  'viewer-b': requiredEnv('PULSE_ROSTER_TEST_VIEWER_B'),
  outsider: requiredEnv('PULSE_ROSTER_TEST_OUTSIDER'),
};
for (const subject of Object.values(subjects)) {
  if (!/^user_[A-Za-z0-9_-]+$/.test(subject)) throw new Error('Invalid fixture subject');
}

// Test-only stub avoids real WorkOS tokens; it does NOT validate cryptography.
// WorkOS JWT verification is separately tested by the authentication suite.
const verify: TokenVerifier = async (token) => {
  const subject = subjects[token];
  return subject ? {
    sub: subject,
    sid: `session_fixture_${token.replace(/-/g, '_')}`,
    iss: 'https://integration-test.invalid',
    exp: Math.floor(Date.now() / 1000) + 3600,
  } : null;
};

let server: Server | undefined;
let baseUrl = '';

before(async () => {
  const app = express();
  app.use('/api', requireWorkOSUser(verify));
  app.get('/api/organizations/:organizationId/members', createMembershipRosterRoute());
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) =>
      server!.close(error => error ? reject(error) : resolve()));
  }
  await closeDatabase();
});

function roster(orgId: string, actor?: string, query = ''): Promise<Response> {
  const headers = actor ? { Authorization: `Bearer ${actor}` } : undefined;
  return fetch(`${baseUrl}/api/organizations/${orgId}/members${query}`, { headers });
}

async function readRoster(response: Response): Promise<{ organizationId: string; members: Array<{ userId: string; role: string; displayName: string | null; joinedAt: string }> }> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(typeof body?.organizationId, 'string');
  assert.ok(Array.isArray(body?.members));
  return body;
}

const allRoles = new Set(['owner', 'admin', 'member', 'viewer']);

function verifyRoster(body: Awaited<ReturnType<typeof readRoster>>, expectedOrg: string) {
  assert.equal(body.organizationId, expectedOrg);
  assert.equal(body.members.length, 4);
  assert.deepEqual(new Set(body.members.map(m => m.role)), allRoles);
  assert.equal(new Set(body.members.map(m => m.userId)).size, 4);
  for (const member of body.members) {
    assert.match(member.userId, UUID);
    assert.equal(typeof member.displayName, 'string');
    assert.equal(typeof member.joinedAt, 'string');
  }
  assert.doesNotMatch(JSON.stringify(body), /authSubject|auth_subject|email|token/i);
}

test('missing and invalid bearer tokens return 401 before database access', async () => {
  assert.equal((await roster(orgA)).status, 401);
  assert.equal((await roster(orgA, 'invalid-fixture-token')).status, 401);
});

test('invalid organization UUID is rejected with 400', async () => {
  assert.equal((await roster('not-a-uuid', 'owner-a')).status, 400);
});

test('owner A sees only organization A membership roster', async () => {
  verifyRoster(await readRoster(await roster(orgA, 'owner-a')), orgA);
});

test('admin A can read organization A roster', async () => {
  verifyRoster(await readRoster(await roster(orgA, 'admin-a')), orgA);
});

test('member and viewer of organization A are denied without member details', async () => {
  for (const actor of ['member-a', 'viewer-a']) {
    const response = await roster(orgA, actor);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'organization_access_denied' });
  }
});

test('organization A owner cannot read B; organization B owner cannot read A', async () => {
  for (const [org, actor] of [[orgB, 'owner-a'], [orgA, 'owner-b']]) {
    const response = await roster(org, actor);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'organization_access_denied' });
  }
});

test('unaffiliated user cannot read either organization roster', async () => {
  for (const org of [orgA, orgB]) {
    assert.equal((await roster(org, 'outsider')).status, 403);
  }
});

test('organization B owner and admin can read only B roster', async () => {
  const ownerRoster = await readRoster(await roster(orgB, 'owner-b'));
  const adminRoster = await readRoster(await roster(orgB, 'admin-b'));
  verifyRoster(ownerRoster, orgB);
  verifyRoster(adminRoster, orgB);
  assert.deepEqual(adminRoster.members, ownerRoster.members);
  const aRoster = await readRoster(await roster(orgA, 'owner-a'));
  const aIds = new Set(aRoster.members.map(m => m.userId));
  for (const item of ownerRoster.members) assert.equal(aIds.has(item.userId), false);
});

test('query parameters cannot impersonate an owner or switch organizations', async () => {
  const response = await roster(orgA, 'viewer-a', `?userId=${encodeURIComponent(subjects['owner-a'])}&role=owner&organizationId=${orgB}`);
  assert.equal(response.status, 403);
});

test('transaction-local context does not leak into subsequent unscoped queries', async () => {
  await readRoster(await roster(orgA, 'owner-a'));
  const unscoped = await getDatabase().select({ userId: organizationMemberships.userId })
    .from(organizationMemberships);
  assert.deepEqual(unscoped, []);
});
