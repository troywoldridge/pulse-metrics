import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { createIdentityRoute, type IdentityResolver } from './auth/identity-route.js';
import { requireWorkOSUser, type TokenVerifier } from './auth/workos-auth.js';

const USER_ID = '52bc1082-0b0f-4ebd-a0ce-a3fffc15b045';
const SUBJECT = 'user_pulse_identity_test';
let server: Server;
let baseUrl: string;
let lastResolvedSubject: string | undefined;
let resolutionCount = 0;

const verify: TokenVerifier = async token => token === 'good.token.signature'
  ? {
      sub: SUBJECT,
      sid: 'session_pulse_test',
      iss: 'https://example.invalid',
      exp: Math.floor(Date.now() / 1000) + 600,
    }
  : null;

const resolve: IdentityResolver = async identity => {
  resolutionCount += 1;
  lastResolvedSubject = identity.subject;
  if (identity.subject !== SUBJECT || identity.sessionId !== 'session_pulse_test') {
    throw new Error('unexpected verified subject');
  }
  return USER_ID;
};

before(async () => {
  const app = express();
  app.use('/api', requireWorkOSUser(verify));
  app.get('/api/auth/me', createIdentityRoute(resolve));
  app.use('/api', (_req, res) => res.status(503).json({ error: 'organization_authorization_pending' }));
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    });
  }
});

test('missing bearer returns 401 before provisioning is invoked', async () => {
  const beforeCount = resolutionCount;
  const response = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(response.status, 401);
  assert.equal(resolutionCount, beforeCount);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('invalid bearer returns 401 before provisioning is invoked', async () => {
  const beforeCount = resolutionCount;
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: 'Bearer invalid.token.signature' },
  });
  assert.equal(response.status, 401);
  assert.equal(resolutionCount, beforeCount);
});

test('verified bearer resolves internal UUID without granting organizations', async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: 'Bearer good.token.signature' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(lastResolvedSubject, SUBJECT);
  assert.deepEqual(await response.json(), {
    provider: 'workos',
    subject: SUBJECT,
    userId: USER_ID,
  });
});

test('old history endpoint remains unavailable even to authenticated users', async () => {
  const response = await fetch(`${baseUrl}/api/history`, {
    headers: { Authorization: 'Bearer good.token.signature' },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'organization_authorization_pending' });
});

test('database provisioning error returns 503 without leaking details', async () => {
  const app = express();
  app.use(requireWorkOSUser(verify));
  app.get('/api/auth/me', createIdentityRoute(async () => {
    throw new Error('private database diagnostic, password=SECRET');
  }));
  const listener = createServer(app);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  try {
    const addr = listener.address();
    if (!addr || typeof addr === 'string') throw new Error('Test listener unavailable');
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/auth/me`, {
      headers: { Authorization: 'Bearer good.token.signature' },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    const body = await response.text();
    assert.equal(JSON.parse(body).error, 'identity_provisioning_unavailable');
    assert.doesNotMatch(body, /password|SECRET|private database diagnostic/);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      listener.close(error => error ? reject(error) : resolveClose());
    });
  }
});

test('identity route fails closed when mounted without authentication middleware', async () => {
  const app = express();
  app.get('/api/auth/me', createIdentityRoute(resolve));
  const listener = createServer(app);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  try {
    const addr = listener.address();
    if (!addr || typeof addr === 'string') throw new Error('Test listener unavailable');
    const beforeCount = resolutionCount;
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/auth/me`);
    assert.equal(response.status, 401);
    assert.equal(resolutionCount, beforeCount);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      listener.close(error => error ? reject(error) : resolveClose());
    });
  }
});
