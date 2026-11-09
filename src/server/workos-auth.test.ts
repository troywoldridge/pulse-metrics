import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import {
  readWorkOSAuthConfig,
  requireWorkOSUser,
  tokenMatchesRecipient,
  type TokenVerifier,
  type VerifiedWorkOSClaims,
} from './auth/workos-auth.js';

const config = {
  clientId: 'client_test_pulse',
  issuer: 'https://test.authkit.app',
  audience: 'urn:pulse-metrics:api:local',
};

function claims(overrides: Record<string, unknown> = {}): VerifiedWorkOSClaims {
  return {
    sub: 'user_test_123',
    sid: 'session_test_123',
    iss: config.issuer,
    exp: Math.floor(Date.now() / 1000) + 600,
    client_id: config.clientId,
    aud: config.audience,
    ...overrides,
  };
}

test('startup configuration fails closed when issuer or audience is missing', () => {
  assert.throws(() => readWorkOSAuthConfig({ WORKOS_CLIENT_ID: config.clientId }), /ISSUER/);
  assert.throws(() => readWorkOSAuthConfig({
    WORKOS_CLIENT_ID: config.clientId,
    WORKOS_TOKEN_ISSUER: config.issuer,
  }), /AUDIENCE/);
  assert.deepEqual(readWorkOSAuthConfig({
    WORKOS_CLIENT_ID: config.clientId,
    WORKOS_TOKEN_ISSUER: config.issuer,
    WORKOS_TOKEN_AUDIENCE: config.audience,
    VITE_WORKOS_CLIENT_ID: config.clientId,
  }), config);
});

test('recipient binding rejects other audiences, other apps, expired and missing claims', () => {
  assert.equal(tokenMatchesRecipient(claims(), config), true);
  assert.equal(tokenMatchesRecipient(claims({ aud: ['other', config.audience] }), config), true);
  assert.equal(tokenMatchesRecipient(claims({ aud: 'wrong' }), config), false);
  assert.equal(tokenMatchesRecipient(claims({ aud: undefined }), config), false);
  assert.equal(tokenMatchesRecipient(claims({ client_id: 'client_other' }), config), false);
  assert.equal(tokenMatchesRecipient(claims({ client_id: undefined }), config), false);
  assert.equal(tokenMatchesRecipient(claims({ iss: 'https://attacker.invalid' }), config), false);
  assert.equal(tokenMatchesRecipient(claims({ exp: 1 }), config), false);
  assert.equal(tokenMatchesRecipient(claims({ sub: 'agent_reg_other' }), config), false);
});

let server: Server;
let baseUrl: string;
const verifier: TokenVerifier = async (token) => {
  if (token === 'good.token.signature') return claims();
  if (token === 'service.failure') throw new Error('private JWKS diagnostic');
  return null;
};

before(async () => {
  const app = express();
  app.get('/api/auth/me', requireWorkOSUser(verifier), (_req, res) => {
    res.json(res.locals.authenticatedIdentity);
  });
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Test HTTP listener unavailable');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('missing token is rejected with 401', async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('malformed or invalid token is rejected with 401', async () => {
  const malformed = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: 'Basic secret' },
  });
  assert.equal(malformed.status, 401);
  const bad = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: 'Bearer bad.token.signature' },
  });
  assert.equal(bad.status, 401);
});

test('verified WorkOS identity is returned without organization privileges', async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: 'Bearer good.token.signature' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    provider: 'workos',
    subject: 'user_test_123',
    sessionId: 'session_test_123',
  });
});

test('temporary verifier outage returns 503 and never echoes token or exception', async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: 'Bearer service.failure' },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  const body = await response.text();
  assert.doesNotMatch(body, /service\.failure|private JWKS diagnostic/);
});
