import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from './auth/workos-auth.js';
import {
  createCreateOrganizationRoute,
  createListOrganizationsRoute,
  parseOrganizationProposal,
  type CreateOrganization,
  type ListOrganizations,
} from './auth/organization-route.js';
import { OrganizationSlugConflictError } from './auth/organization-service.js';

const OWNER = {
  id: '20bb6e83-2b46-4357-8db1-ae2dc968b7de',
  name: 'Pulse Test Company',
  slug: 'pulse-test-company',
  role: 'owner' as const,
};
const subject = 'user_test_creator';
const calls: { subject: string; proposal: unknown }[] = [];
let forceError: 'conflict' | 'database' | null = null;

const verify: TokenVerifier = async token =>
  token === 'valid.test.token' || token === 'another.valid.token'
    ? { sub: token === 'another.valid.token' ? 'user_other_verified' : subject,
        sid: 'session_test', iss: 'https://example.invalid', exp: 4102444800 }
    : null;

const create: CreateOrganization = async (identity, proposal) => {
  calls.push({ subject: identity.subject, proposal });
  if (forceError === 'conflict') throw new OrganizationSlugConflictError();
  if (forceError === 'database') throw new Error('private database diagnostic');
  return { ...OWNER, name: proposal.name, slug: proposal.slug };
};
const list: ListOrganizations = async identity => {
  calls.push({ subject: identity.subject, proposal: 'list' });
  if (forceError === 'database') throw new Error('private database diagnostic');
  return [OWNER];
};

let server: Server;
let unauthServer: Server;
let base: string;
let bare: string;

async function listen(app: ReturnType<typeof express>): Promise<[Server, string]> {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('Missing test listener');
  return [server, `http://127.0.0.1:${addr.port}`];
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api', requireWorkOSUser(verify));
  app.get('/api/organizations', createListOrganizationsRoute(list));
  app.post('/api/organizations', createCreateOrganizationRoute(create));
  [server, base] = await listen(app);

  const noAuth = express();
  noAuth.use(express.json());
  noAuth.get('/api/organizations', createListOrganizationsRoute(list));
  noAuth.post('/api/organizations', createCreateOrganizationRoute(create));
  [unauthServer, bare] = await listen(noAuth);
});

after(async () => {
  for (const current of [server, unauthServer]) {
    if (current?.listening) await new Promise<void>((resolve, reject) =>
      current.close(error => error ? reject(error) : resolve()));
  }
});

const headers = { authorization: 'Bearer valid.test.token', 'content-type': 'application/json' };
const post = (body: unknown, authorized = true) => fetch(`${base}/api/organizations`, {
  method: 'POST',
  headers: authorized ? headers : { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('proposal parser accepts only safe organization details', () => {
  assert.deepEqual(parseOrganizationProposal({ name: '  Company  ', slug: 'my-company' }),
    { name: 'Company', slug: 'my-company' });
  for (const bad of [null, {}, [], { name: '', slug: 'a' },
    { name: 'Good', slug: 'UPPERCASE' },
    { name: 'Good\nNew', slug: 'good' },
    { name: 'Good', slug: 'bad--slug' },
    { name: 'Good', slug: 'okay', role: 'owner' },
    { name: 'Good', slug: 'okay', userId: 'forged' },
    { name: 'A'.repeat(161), slug: 'okay' }]) {
    assert.equal(parseOrganizationProposal(bad), null);
  }
});

test('missing bearer blocks POST and GET before database calls', async () => {
  const before = calls.length;
  assert.equal((await post({ name: 'Example', slug: 'example' }, false)).status, 401);
  assert.equal((await fetch(`${base}/api/organizations`)).status, 401);
  assert.equal(calls.length, before);
});

test('invalid bearer blocks organization creation', async () => {
  const before = calls.length;
  const response = await fetch(`${base}/api/organizations`, {
    method: 'POST', headers: { authorization: 'Bearer invalid.test.token', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Example', slug: 'example' }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls.length, before);
});

test('verified user can create an organization with fixed owner output', async () => {
  const response = await post({ name: ' Company ', slug: 'company' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { organization: { ...OWNER, name: 'Company', slug: 'company' } });
  assert.deepEqual(calls.at(-1), { subject, proposal: { name: 'Company', slug: 'company' } });
});

test('organization creator always comes from the verified bearer', async () => {
  const response = await fetch(`${base}/api/organizations`, {
    method: 'POST',
    headers: { authorization: 'Bearer another.valid.token', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Another Verified Account', slug: 'another-verified-account' }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(calls.at(-1), {
    subject: 'user_other_verified',
    proposal: { name: 'Another Verified Account', slug: 'another-verified-account' },
  });
});

test('list failures return sanitized 503 rather than disclosing SQL', async () => {
  forceError = 'database';
  try {
    const response = await fetch(`${base}/api/organizations`, { headers });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private database diagnostic/);
  } finally { forceError = null; }
});

test('browser-supplied role and userId are rejected before database work', async () => {
  const before = calls.length;
  const response = await post({ name: 'Bad', slug: 'bad', role: 'owner', userId: 'other' });
  assert.equal(response.status, 400);
  assert.equal(calls.length, before);
});

test('non-JSON POST is rejected', async () => {
  const before = calls.length;
  const response = await fetch(`${base}/api/organizations`, {
    method: 'POST', headers: { authorization: 'Bearer valid.test.token', 'content-type': 'text/plain' },
    body: 'name=Hello&slug=hello',
  });
  assert.equal(response.status, 415);
  assert.equal(calls.length, before);
});

test('slug conflicts return 409 without diagnostic details', async () => {
  forceError = 'conflict';
  try {
    const response = await post({ name: 'Duplicate', slug: 'duplicate' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'organization_slug_taken' });
  } finally { forceError = null; }
});

test('database failures return 503 without private errors', async () => {
  forceError = 'database';
  try {
    const response = await post({ name: 'Test', slug: 'test' });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private database diagnostic/);
  } finally { forceError = null; }
});

test('GET lists only organizations returned for the verified subject', async () => {
  const response = await fetch(`${base}/api/organizations`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { organizations: [OWNER] });
  assert.deepEqual(calls.at(-1), { subject, proposal: 'list' });
});

test('routes refuse identity-less mounting', async () => {
  const before = calls.length;
  assert.equal((await fetch(`${bare}/api/organizations`)).status, 401);
  const response = await fetch(`${bare}/api/organizations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test', slug: 'test' }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls.length, before);
});
