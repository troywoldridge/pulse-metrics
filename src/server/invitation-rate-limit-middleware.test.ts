import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from './auth/workos-auth.js';
import { createInvitationRateLimitGuards } from './security/invitation-rate-limit-middleware.js';
import {
  InvitationRateLimitExceededError,
  type InvitationAction,
  type InvitationBucketKind,
} from './security/invitation-rate-limit.js';

const subject = 'user_middleware_test_123';
const verifier: TokenVerifier = async bearer => bearer === 'ok.test.token'
  ? { sub: subject, sid: 'session_test', iss: 'https://local.invalid', exp: Date.now()/1000+600 }
  : null;

async function withApp(
  setup: (app: ReturnType<typeof express>) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  setup(app);
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No test address');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}

function request(url: string, bearer?: string, forward?: string) {
  return fetch(url + '/api/invitations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(forward ? { 'X-Forwarded-For': forward } : {}),
    },
    body: '{}',
  });
}

function guards(consume: (action: InvitationAction, kind: InvitationBucketKind, value: unknown) => Promise<void>) {
  return createInvitationRateLimitGuards({
    checks: {
      checkNetwork: (action, value) => consume(action, 'network', value),
      checkActor: (action, value) => consume(action, 'actor', value),
    },
    networkMode: 'local-direct-socket', production: false,
  });
}

test('network guard runs before bearer verification, actor only after', async () => {
  const sequence: string[] = [];
  const g = guards(async (_action, kind, value) => {
    sequence.push(kind);
    if (kind === 'actor') assert.equal((value as { subject: string }).subject, subject);
    else assert.equal(value, '127.0.0.1');
  });
  await withApp(app => {
    app.post('/api/invitations', g.network('issue'));
    app.use('/api', requireWorkOSUser(verifier));
    app.post('/api/invitations', g.actor('issue'), (_req, res) => res.status(201).json({ ok: true }));
  }, async url => {
    assert.equal((await request(url)).status, 401);
    assert.deepEqual(sequence, ['network']);
    assert.equal((await request(url, 'ok.test.token')).status, 201);
    assert.deepEqual(sequence, ['network', 'network', 'actor']);
  });
});

test('forwarded headers cannot change network bucket address', async () => {
  const seen: unknown[] = [];
  const g = guards(async (_action, kind, value) => {
    if (kind === 'network') seen.push(value);
  });
  await withApp(app => app.post('/api/invitations', g.network('issue'), (_req,res)=>res.sendStatus(204)), async url => {
    assert.equal((await request(url, undefined, '203.0.113.7')).status, 204);
    assert.equal((await request(url, undefined, '198.51.100.19')).status, 204);
    assert.deepEqual(seen, ['127.0.0.1', '127.0.0.1']);
  });
});

test('429 returned for network denial before auth, with bounded retry header', async () => {
  const g = guards(async () => { throw new InvitationRateLimitExceededError(45); });
  await withApp(app => {
    app.post('/api/invitations', g.network('accept'));
    app.use('/api', requireWorkOSUser(verifier));
    app.post('/api/invitations', (_req,res)=>res.sendStatus(200));
  }, async url => {
    const res = await request(url);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '45');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'invitation_rate_limited' });
  });
});

test('429 returned for actor denial, without passing to operation', async () => {
  let invoked = 0;
  const g = guards(async (_action, kind) => {
    if (kind === 'actor') throw new InvitationRateLimitExceededError(117);
  });
  await withApp(app => {
    app.post('/api/invitations', g.network('issue'));
    app.use('/api', requireWorkOSUser(verifier));
    app.post('/api/invitations', g.actor('issue'), (_req,res)=>{invoked++; res.sendStatus(200);});
  }, async url => {
    const res = await request(url, 'ok.test.token');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '117');
    assert.equal(invoked, 0);
  });
});

test('storage errors fail closed and do not expose private diagnostics', async () => {
  let invoked = 0;
  const g = guards(async () => { throw new Error('private database connection password'); });
  await withApp(app => app.post('/api/invitations', g.network('issue'), (_req,res)=>{
    invoked++; res.sendStatus(200);
  }), async url => {
    const res = await request(url, 'ok.test.token');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '5');
    assert.deepEqual(await res.json(), { error: 'invitation_rate_limit_unavailable' });
    assert.equal(invoked, 0);
  });
});

test('missing key, disabled mode and production mode each fail closed', async () => {
  for (const options of [
    { checks: null, networkMode: 'local-direct-socket' as const, production: false },
    { checks: { checkNetwork: async () => {}, checkActor: async () => {} }, networkMode: 'disabled' as const, production: false },
    { checks: null, networkMode: 'local-direct-socket' as const, production: true },
  ]) {
    const g = createInvitationRateLimitGuards(options);
    await withApp(app => app.post('/api/invitations', g.network('issue'), (_req,res)=>res.sendStatus(200)), async url => {
      assert.equal((await request(url)).status, 503);
    });
  }
});

test('actor guard without verified middleware denies without database access', async () => {
  let calls = 0;
  const g = guards(async () => { calls++; });
  await withApp(app => app.post('/api/invitations', g.actor('accept'), (_req,res)=>res.sendStatus(200)), async url => {
    assert.equal((await request(url)).status, 401);
    assert.equal(calls, 0);
  });
});
