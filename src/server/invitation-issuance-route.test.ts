import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from './auth/workos-auth.js';
import {
  createInvitationIssuanceRoute,
  parseInvitationProposal,
  type InvitationIssuer,
} from './auth/invitation-issuance-route.js';
import { InvitationIssuanceDeniedError } from './auth/invitation-issuance-service.js';

const ORGANIZATION = '20bb6e83-2b46-4357-8db1-ae2dc968b7de';
const INVITATION_ID = 'b8d9b2a7-c9ec-4a09-a5b6-308b3cb439a4';
const ONE_TIME_TOKEN = 'a'.repeat(43);
const EXPIRES_AT = '2026-11-11T21:00:00.000Z';
const CALLS: { subject: string; organizationId: string; proposal: unknown }[] = [];
let failure: 'denied' | 'database' | 'bad-output' | null = null;

const verify: TokenVerifier = async token =>
  token === 'valid.test.token' || token === 'other.test.token'
    ? { sub: token === 'other.test.token' ? 'user_another_user' : 'user_test_inviter',
        sid: 'session_test', iss: 'https://example.invalid', exp: 4102444800 }
    : null;

const issue: InvitationIssuer = async (identity, organizationId, proposal) => {
  CALLS.push({ subject: identity.subject, organizationId, proposal });
  if (failure === 'denied') throw new InvitationIssuanceDeniedError();
  if (failure === 'database') throw new Error('private SQL and credential diagnostic');
  if (failure === 'bad-output') {
    return {
      invitation: { id: INVITATION_ID, organizationId: '00000000-0000-4000-8000-000000000000',
        invitedEmail: proposal.email, invitedRole: proposal.role, expiresAt: EXPIRES_AT },
      oneTimeToken: ONE_TIME_TOKEN,
    };
  }
  return {
    invitation: {
      id: INVITATION_ID, organizationId,
      invitedEmail: proposal.email, invitedRole: proposal.role, expiresAt: EXPIRES_AT,
    },
    oneTimeToken: ONE_TIME_TOKEN,
  };
};

let server: Server;
let bareServer: Server;
let base: string;
let bare: string;

async function listen(app: ReturnType<typeof express>): Promise<[Server, string]> {
  const listener = createServer(app);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Test port unavailable');
  return [listener, `http://127.0.0.1:${address.port}`];
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api', requireWorkOSUser(verify));
  app.post('/api/organizations/:organizationId/invitations', createInvitationIssuanceRoute(issue));
  [server, base] = await listen(app);

  const missingMiddleware = express();
  missingMiddleware.use(express.json());
  missingMiddleware.post('/api/organizations/:organizationId/invitations', createInvitationIssuanceRoute(issue));
  [bareServer, bare] = await listen(missingMiddleware);
});

after(async () => {
  for (const current of [server, bareServer]) {
    if (current?.listening) await new Promise<void>((resolve, reject) =>
      current.close(error => error ? reject(error) : resolve()));
  }
});

function post(body: unknown, token: string | null = 'valid.test.token', organizationId = ORGANIZATION) {
  return fetch(`${base}/api/organizations/${organizationId}/invitations`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const valid = { email: 'INVITED@EXAMPLE.COM', role: 'member' };

test('invitation parser normalizes a recipient and permits only admin/member/viewer', () => {
  for (const role of ['admin', 'member', 'viewer'] as const) {
    assert.deepEqual(parseInvitationProposal({ email: '  Test.User+1@EXAMPLE.COM  ', role }),
      { email: 'test.user+1@example.com', role });
  }
});

test('parser rejects invalid, oversized and ambiguous requests', () => {
  for (const input of [null, [], {}, { email: 'test@example.com' },
    { email: 'test@example.com', role: 'owner' },
    { email: 'a@example.com', role: 'viewer', userId: 'forged' },
    { email: 'a@example.com', role: 'viewer', tokenHash: 'abc' },
    { email: 'a@example.com', role: 'viewer', expiresAt: 1 },
    { email: 'a@example.com', role: 'viewer', organizationId: ORGANIZATION },
    { email: 'a@example.com', role: 'viewer', actorSubject: 'user_fake' },
    { email: 'a@example.com\r\nCc:evil@example.com', role: 'viewer' },
    { email: 'invalid', role: 'member' },
    { email: 'a'.repeat(321) + '@example.com', role: 'member' },
    { email: 3, role: 'viewer' }, { email: 'a@example.com', role: null }]) {
    assert.equal(parseInvitationProposal(input), null);
  }
});

test('missing bearer returns 401 before database operation', async () => {
  const previous = CALLS.length;
  const response = await post(valid, null);
  assert.equal(response.status, 401);
  assert.equal(CALLS.length, previous);
});

test('invalid bearer returns 401 before database operation', async () => {
  const previous = CALLS.length;
  const response = await post(valid, 'invalid.test.token');
  assert.equal(response.status, 401);
  assert.equal(CALLS.length, previous);
});

test('invalid organization IDs are rejected before database operation', async () => {
  const previous = CALLS.length;
  const response = await post(valid, 'valid.test.token', 'not-a-uuid');
  assert.equal(response.status, 400);
  assert.equal(CALLS.length, previous);
});

test('non-JSON posts are rejected before database operation', async () => {
  const previous = CALLS.length;
  const response = await fetch(`${base}/api/organizations/${ORGANIZATION}/invitations`, {
    method: 'POST', headers: { authorization: 'Bearer valid.test.token', 'content-type': 'text/plain' },
    body: 'email=someone@example.com&role=viewer',
  });
  assert.equal(response.status, 415);
  assert.equal(CALLS.length, previous);
});

test('verified identity issues only the normalized proposal with no-store response', async () => {
  const response = await post(valid);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    invitation: { id: INVITATION_ID, organizationId: ORGANIZATION,
      invitedEmail: 'invited@example.com', invitedRole: 'member', expiresAt: EXPIRES_AT },
    oneTimeToken: ONE_TIME_TOKEN,
  });
  assert.deepEqual(CALLS.at(-1), { subject: 'user_test_inviter', organizationId: ORGANIZATION,
    proposal: { email: 'invited@example.com', role: 'member' } });
});

test('verified identity is derived from bearer, never request parameters', async () => {
  const response = await fetch(`${base}/api/organizations/${ORGANIZATION}/invitations?userId=forged&role=owner`, {
    method: 'POST',
    headers: { authorization: 'Bearer other.test.token', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'another@example.com', role: 'viewer' }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(CALLS.at(-1), { subject: 'user_another_user', organizationId: ORGANIZATION,
    proposal: { email: 'another@example.com', role: 'viewer' } });
});

test('body-supplied user identities, owner role and token hash are rejected', async () => {
  const previous = CALLS.length;
  for (const body of [
    { email: 'a@example.com', role: 'owner' },
    { email: 'a@example.com', role: 'viewer', userId: 'some-other-user' },
    { email: 'a@example.com', role: 'viewer', tokenHash: 'bogus' },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400);
  }
  assert.equal(CALLS.length, previous);
});

test('unauthorized organization/role maps to 403 with no membership details', async () => {
  failure = 'denied';
  try {
    const response = await post(valid);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'organization_access_denied' });
  } finally { failure = null; }
});

test('database failure maps to sanitized 503 and never exposes a token', async () => {
  failure = 'database';
  try {
    const response = await post(valid);
    assert.equal(response.status, 503);
    const responseBody = await response.text();
    assert.doesNotMatch(responseBody, /private|SQL|credential|oneTimeToken|aaaaaaa/i);
    assert.equal(response.headers.get('retry-after'), '5');
  } finally { failure = null; }
});

test('unexpected service organization is never returned to the client', async () => {
  failure = 'bad-output';
  try {
    const response = await post(valid);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /oneTimeToken|aaaaaaa/i);
  } finally { failure = null; }
});

test('route mounted without authentication middleware fails closed', async () => {
  const previous = CALLS.length;
  const response = await fetch(`${bare}/api/organizations/${ORGANIZATION}/invitations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
  });
  assert.equal(response.status, 401);
  assert.equal(CALLS.length, previous);
});
