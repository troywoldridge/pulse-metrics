import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from './auth/workos-auth.js';
import { createInvitationRateLimitGuards, createLiveInvitationRateLimitGuards } from './security/invitation-rate-limit-middleware.js';
import { InvitationRateLimitExceededError } from './security/invitation-rate-limit.js';
import { parseTrustedProxyCidrs } from './security/trusted-client-address.js';

const verifier: TokenVerifier = async token => token === 'valid.test'
  ? { sub: 'user_proxy_test', sid: 'session_proxy', iss: 'https://test.invalid', exp: Date.now()/1000+600 }
  : null;

async function withApp(
  build: (app: ReturnType<typeof express>) => void,
  check: (url: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  build(app);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('No listener');
  try { await check(`http://127.0.0.1:${addr.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
function send(url: string, xff?: string, bearer?: string, additional: Record<string,string> = {}) {
  return fetch(url+'/invites', { method: 'POST', headers: {
    'Content-Type': 'application/json',
    ...(xff === undefined ? {} : { 'X-Forwarded-For': xff }),
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...additional,
  }, body: '{}' });
}
const trustedProxies = parseTrustedProxyCidrs('127.0.0.1/32');

test('trusted-proxy mode applies network before authentication and actor after it', async () => {
  const seen: string[] = [];
  const guards = createInvitationRateLimitGuards({
    checks: {
      checkNetwork: async (_action, address) => { seen.push(`network:${address}`); },
      checkActor: async (_action, id) => { seen.push(`actor:${id.subject}`); },
    }, trustedProxies, networkMode: 'trusted-proxy', production: false,
  });
  await withApp(app => {
    app.post('/invites', guards.network('issue'));
    app.use(requireWorkOSUser(verifier));
    app.post('/invites', guards.actor('issue'), (_req,res) => res.sendStatus(201));
  }, async url => {
    assert.equal((await send(url, '198.51.100.4')).status, 401);
    assert.equal((await send(url, '198.51.100.4', 'valid.test')).status, 201);
    assert.deepEqual(seen, ['network:198.51.100.4','network:198.51.100.4','actor:user_proxy_test']);
  });
});

test('spoofed leftmost XFF and conflicting X-Real-IP do not change the bucket', async () => {
  const seen: unknown[] = [];
  const guards = createInvitationRateLimitGuards({
    checks: { checkNetwork: async (_act, ip) => { seen.push(ip); }, checkActor: async () => {} },
    trustedProxies, networkMode: 'trusted-proxy', production: false,
  });
  await withApp(app => app.post('/invites', guards.network('issue'), (_req,res) => res.sendStatus(204)), async url => {
    assert.equal((await send(url, '203.0.113.2, 198.51.100.4',undefined,{'X-Real-IP':'203.0.113.9'})).status, 204);
    assert.equal((await send(url, '192.0.2.33, 198.51.100.4')).status, 204);
    assert.deepEqual(seen, ['198.51.100.4','198.51.100.4']);
  });
});

test('malformed or missing forwarded chain fails with 503 before JWT and without quota write', async () => {
  let calls = 0;
  const guards = createInvitationRateLimitGuards({
    checks: { checkNetwork: async () => { calls++; }, checkActor: async () => { calls++; } },
    trustedProxies, networkMode: 'trusted-proxy', production: false,
  });
  await withApp(app => {
    app.post('/invites', guards.network('accept'));
    app.use(requireWorkOSUser(verifier));
    app.post('/invites', guards.actor('accept'), (_req,res) => res.sendStatus(200));
  }, async url => {
    for (const xff of [undefined, 'unknown', '127.0.0.1', '198.51.100.1,,203.0.113.2']) {
      const response = await send(url, xff, 'valid.test');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(response.headers.get('retry-after'),'5');
      assert.deepEqual(await response.json(), { error:'invitation_rate_limit_unavailable' });
    }
  });
  assert.equal(calls, 0);
});

test('quota denial remains sanitized and stops before WorkOS validation', async () => {
  const guards = createInvitationRateLimitGuards({
    checks: {
      checkNetwork: async () => { throw new InvitationRateLimitExceededError(13); },
      checkActor: async () => { throw Error('must not run'); },
    }, trustedProxies, networkMode: 'trusted-proxy', production: false,
  });
  await withApp(app => app.post('/invites',guards.network('issue'), (_req,res) => res.sendStatus(200)), async url => {
    const response = await send(url, '198.51.100.4');
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '13');
    assert.deepEqual(await response.json(), { error:'invitation_rate_limited' });
  });
});

test('production is disabled even with an apparently valid trusted-proxy policy', async () => {
  const guards = createInvitationRateLimitGuards({
    checks: { checkNetwork: async () => { throw Error('not used'); }, checkActor: async () => {} },
    trustedProxies, networkMode: 'trusted-proxy', production: true,
  });
  await withApp(app => app.post('/invites', guards.network('issue'), (_req,res)=>res.sendStatus(200)), async url => {
    assert.equal((await send(url,'198.51.100.4')).status, 503);
  });
});

test('missing explicit CIDR list fails closed in live factory', async () => {
  const guards = createLiveInvitationRateLimitGuards({
    NODE_ENV: 'development', INVITATION_RATE_LIMIT_NETWORK_MODE: 'trusted-proxy',
    INVITATION_RATE_LIMIT_HMAC_KEY: Buffer.alloc(32, 2).toString('base64url'),
    INVITATION_TRUSTED_PROXY_CIDRS: '0.0.0.0/0',
  });
  await withApp(app => app.post('/invites',guards.network('issue'),(_req,res)=>res.sendStatus(200)), async url => {
    assert.equal((await send(url,'198.51.100.4')).status,503);
  });
});
