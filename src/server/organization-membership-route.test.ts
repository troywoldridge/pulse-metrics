import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from './auth/workos-auth.js';
import {
  createMembershipRosterRoute,
  type MembershipRosterLoader,
} from './auth/organization-membership-route.js';
import {
  canReadMembershipRoster,
  MembershipAccessDeniedError,
} from './auth/organization-membership-service.js';

const ORG_A = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const ORG_B = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
const USER = '28c7555b-a1a5-47c8-87d8-e784906e986e';
const FIXTURE_DATE = new Date('2026-11-10T00:00:00.000Z');
const called: Array<{ subject: string; organizationId: string }> = [];
let behavior: 'ok' | 'deny' | 'error' | 'malformed' = 'ok';

const verifier: TokenVerifier = async (token) => token === 'good.test.token'
  ? { sub: 'user_verified_caller', sid: 'session_verified_caller',
      iss: 'https://example.invalid', exp: 4102444800 }
  : null;

const load: MembershipRosterLoader = async (identity, organizationId) => {
  called.push({ subject: identity.subject, organizationId });
  if (behavior === 'deny') throw new MembershipAccessDeniedError();
  if (behavior === 'error') throw new Error('PRIVATE_DATABASE_DIAGNOSTIC');
  if (behavior === 'malformed') return { organizationId: ORG_B, members: [] };
  return { organizationId, members: [{ userId: USER, role: 'owner', displayName: null, joinedAt: FIXTURE_DATE }] };
};

let protectedServer: Server;
let bareServer: Server;
let baseUrl: string;
let bareUrl: string;

async function listen(app: ReturnType<typeof express>): Promise<[Server, string]> {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing test listener');
  return [server, `http://127.0.0.1:${addr.port}`];
}

before(async () => {
  const app = express();
  app.use('/api', requireWorkOSUser(verifier));
  app.get('/api/organizations/:organizationId/members', createMembershipRosterRoute(load));
  [protectedServer, baseUrl] = await listen(app);

  const noAuth = express();
  noAuth.get('/api/organizations/:organizationId/members', createMembershipRosterRoute(load));
  [bareServer, bareUrl] = await listen(noAuth);
});

after(async () => {
  for (const server of [protectedServer, bareServer]) {
    if (server?.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});

async function get(organizationId = ORG_A, token = 'good.test.token') {
  return fetch(`${baseUrl}/api/organizations/${organizationId}/members`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

test('membership roster role matrix fails closed', () => {
  assert.equal(canReadMembershipRoster('owner'), true);
  assert.equal(canReadMembershipRoster('admin'), true);
  for (const role of ['member', 'viewer', 'OWNER', '', undefined, null, 'super-admin']) {
    assert.equal(canReadMembershipRoster(role), false);
  }
});

test('missing bearer is rejected before loading membership data', async () => {
  const count = called.length;
  const response = await fetch(`${baseUrl}/api/organizations/${ORG_A}/members`);
  assert.equal(response.status, 401);
  assert.equal(called.length, count);
});

test('invalid bearer is rejected before loading membership data', async () => {
  const count = called.length;
  assert.equal((await get(ORG_A, 'bad.test.token')).status, 401);
  assert.equal(called.length, count);
});

test('invalid organization IDs are rejected without touching the database', async () => {
  const count = called.length;
  assert.equal((await get('not-a-uuid')).status, 400);
  assert.equal(called.length, count);
});

test('valid identity lists only the authorized roster result', async () => {
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    organizationId: ORG_A,
    members: [{ userId: USER, role: 'owner', displayName: null, joinedAt: FIXTURE_DATE.toISOString() }],
  });
  assert.deepEqual(called.at(-1), { subject: 'user_verified_caller', organizationId: ORG_A });
});

test('membership access denied returns 403 without roster details', async () => {
  behavior = 'deny';
  try {
    const response = await get(ORG_B);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'organization_access_denied' });
  } finally { behavior = 'ok'; }
});

test('database errors become sanitized 503 responses', async () => {
  behavior = 'error';
  try {
    const response = await get();
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.doesNotMatch(body, /PRIVATE_DATABASE_DIAGNOSTIC/);
  } finally { behavior = 'ok'; }
});

test('a mismatched organization in a service response fails closed', async () => {
  behavior = 'malformed';
  try {
    assert.equal((await get(ORG_A)).status, 503);
  } finally { behavior = 'ok'; }
});

test('routes fail closed when mounted without WorkOS middleware', async () => {
  const count = called.length;
  const response = await fetch(`${bareUrl}/api/organizations/${ORG_A}/members`);
  assert.equal(response.status, 401);
  assert.equal(called.length, count);
});

test('request query values cannot replace the verified identity', async () => {
  const response = await fetch(`${baseUrl}/api/organizations/${ORG_A}/members?userId=${encodeURIComponent(USER)}&role=owner`, {
    headers: { Authorization: 'Bearer good.test.token' },
  });
  assert.equal(response.status, 200);
  assert.equal(called.at(-1)?.subject, 'user_verified_caller');
});
