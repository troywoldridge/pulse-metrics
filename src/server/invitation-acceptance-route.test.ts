import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from './auth/workos-auth.js';
import {
  createInvitationAcceptanceRoute,
  parseInvitationAcceptanceBody,
} from './auth/invitation-acceptance-route.js';
import {
  InvitationAcceptanceUnavailableError,
  InvitationNotAvailableError,
} from './auth/invitation-acceptance-service.js';

const TOKEN = Buffer.alloc(32, 42).toString('base64url');
const ORG = 'a02c78a6-380d-444c-a2c9-87b76d328901';
const subject = 'user_http_redeem_123';
const verify: TokenVerifier = async bearer => bearer === 'valid.bearer.token'
  ? { sub: subject, sid: 'session_http_123', iss: 'https://issuer.example.invalid', exp: Date.now()/1000 + 3600 }
  : null;

let server: Server;
let url: string;
let calls = 0;
let behavior: 'ok' | 'notfound' | 'outage' | 'badresult' = 'ok';

before(async () => {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use(requireWorkOSUser(verify));
  app.post('/api/invitations/accept', createInvitationAcceptanceRoute(async (identity, token) => {
    calls++;
    assert.equal(identity.subject, subject);
    assert.equal(token, TOKEN);
    if (behavior === 'notfound') throw new InvitationNotAvailableError();
    if (behavior === 'outage') throw new InvitationAcceptanceUnavailableError();
    if (behavior === 'badresult') return { organizationId: ORG, membershipRole: 'owner' as 'viewer' };
    return { organizationId: ORG, membershipRole: 'member' };
  }));
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('Unable to bind test HTTP server');
  url = `http://127.0.0.1:${addr.port}/api/invitations/accept`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
});

const request = (body: unknown, bearer = 'valid.bearer.token', type = 'application/json') =>
  fetch(url, { method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('raw token parser requires only canonical 32-byte token', () => {
  assert.equal(parseInvitationAcceptanceBody({ token: TOKEN }), TOKEN);
  for (const invalid of [null, [], {}, { token: 'invalid' },
    { token: TOKEN, email: 'victim@example.invalid' },
    { token: TOKEN, organizationId: ORG },
    { token: TOKEN, role: 'owner' },
    { token: TOKEN, subject },
  ]) assert.equal(parseInvitationAcceptanceBody(invalid), null);
});

test('absent bearer is denied before redemption', async () => {
  const oldCalls = calls;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({token:TOKEN}) });
  assert.equal(res.status, 401);
  assert.equal(calls, oldCalls);
});

test('invalid bearer is denied before redemption', async () => {
  const oldCalls = calls;
  const res = await request({ token: TOKEN }, 'invalid.bearer.token');
  assert.equal(res.status, 401);
  assert.equal(calls, oldCalls);
});

test('non-JSON posts fail without redeeming', async () => {
  const oldCalls = calls;
  const res = await request('{"token":"x"}', 'valid.bearer.token', 'text/plain');
  assert.equal(res.status, 415);
  assert.equal(calls, oldCalls);
});

test('body-supplied email, role and organization are all rejected', async () => {
  const oldCalls = calls;
  for (const injected of [{ email:'other@example.invalid' }, { role:'owner' }, { organizationId: ORG }, { subject:'user_attacker' }]) {
    const res = await request({ token:TOKEN, ...injected });
    assert.equal(res.status, 400);
  }
  assert.equal(calls, oldCalls);
});

test('malformed token does not contact redemption service', async () => {
  const oldCalls = calls;
  const res = await request({ token:'bad-token' });
  assert.equal(res.status, 400);
  assert.equal(calls, oldCalls);
});

test('verified bearer can redeem with minimal no-store response', async () => {
  behavior = 'ok';
  const res = await request({ token:TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { organizationId:ORG, membershipRole:'member' });
});

test('used, wrong-recipient and missing invitations return same 404', async () => {
  behavior = 'notfound';
  const res = await request({ token:TOKEN });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error:'invitation_unavailable' });
  behavior = 'ok';
});

test('service outages do not leak provider or SQL details', async () => {
  behavior = 'outage';
  const res = await request({ token:TOKEN });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '5');
  assert.deepEqual(await res.json(), { error:'invitation_acceptance_unavailable' });
  behavior = 'ok';
});

test('unexpected owner role from service fails closed', async () => {
  behavior = 'badresult';
  const res = await request({ token:TOKEN });
  assert.equal(res.status, 503);
  behavior = 'ok';
});

test('route without verified identity middleware fails closed', async () => {
  const app = express();
  app.use(express.json());
  app.post('/api/invitations/accept', createInvitationAcceptanceRoute(async () => {
    throw new Error('Should not run');
  }));
  const s = createServer(app);
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw Error('No address');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/invitations/accept`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:TOKEN}),
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => s.close(error => error ? reject(error) : resolve()));
  }
});
