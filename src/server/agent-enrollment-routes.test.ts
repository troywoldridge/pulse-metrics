import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { Express, RequestHandler } from 'express';
import {
  createAgentEnrollmentService,
  EnrollmentNotAvailable,
  EnrollmentPermissionDenied,
  parseEnrollmentLabel,
  parseRedemptionBody,
  type EnrollmentGateway,
} from './agent-enrollment-service.js';
import {
  createIssueAgentEnrollmentRoute,
  createRedeemAgentEnrollmentRoute,
} from './agent-enrollment-routes.js';
import {
  createAgentSecretMaterial,
  hashAgentSecret,
} from './agent-credential-policy.js';

const ORG_A = '1fc0f77f-baf8-4677-af69-886e42c29401';
const ORG_B = '2fc0f77f-baf8-4677-af69-886e42c29402';
const AGENT = '3fc0f77f-baf8-4677-af69-886e42c29403';
const ENROLLMENT = '4fc0f77f-baf8-4677-af69-886e42c29404';
const VERIFIED = { provider: 'workos' as const, subject: 'user_test_owner', sessionId: 'sess_verified' };
const AGENT_BODY = { displayName: 'Test Linux host', hostname: 'test-linux.example', platform: 'linux', architecture: 'x86_64' };

function gateway(overrides: Partial<EnrollmentGateway> = {}): EnrollmentGateway {
  return {
    async issue() { return ENROLLMENT; },
    async redeem() { return { organizationId: ORG_A, agentId: AGENT }; },
    ...overrides,
  };
}

async function serve(app: Express, run: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function appFor(gw: EnrollmentGateway, identity: unknown = VERIFIED) {
  const app = express();
  app.use(express.json({ limit: '2kb' }));
  const testIngress: RequestHandler = (_req, res, next) => {
    // Explicit synthetic security marker ONLY in this local test fixture.
    res.locals.agentEnrollmentIngressVerified = true;
    next();
  };
  const testIdentity: RequestHandler = (_req, res, next) => {
    if (identity) res.locals.authenticatedIdentity = identity;
    next();
  };
  const service = createAgentEnrollmentService(gw);
  app.post('/issue/:organizationId', testIngress, testIdentity, createIssueAgentEnrollmentRoute(service));
  app.post('/redeem', testIngress, createRedeemAgentEnrollmentRoute(service));
  return app;
}

async function post(url: string, payload: unknown, contentType = 'application/json') {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

test('strict issue and redemption body parsers exclude organization/role/credential overrides', () => {
  assert.equal(parseEnrollmentLabel({ label: '  Operations  ' }), 'Operations');
  for (const body of [null, {}, [], { label: '' }, { label: 'x', role: 'owner' }, { label: 'x\n' },
    { label: 'x', tokenHash: '0'.repeat(64) }]) {
    assert.equal(parseEnrollmentLabel(body), null);
  }
  const secret = createAgentSecretMaterial().oneTimeSecret;
  assert.deepEqual(parseRedemptionBody({ token: secret, agent: AGENT_BODY })?.agent, AGENT_BODY);
  for (const body of [null, {}, { token: secret }, { token: secret, agent: AGENT_BODY, organizationId: ORG_B },
    { token: secret, agent: { ...AGENT_BODY, credential: secret } },
    { token: secret + '=', agent: AGENT_BODY }]) {
    assert.equal(parseRedemptionBody(body), null);
  }
});

test('service refuses implicit adapter and unverified workos identity', async () => {
  assert.throws(() => createAgentEnrollmentService(null as unknown as EnrollmentGateway), TypeError);
  const service = createAgentEnrollmentService(gateway());
  await assert.rejects(() => service.issue({ ...VERIFIED, provider: 'invalid' } as never, ORG_A, 'x'), TypeError);
  await assert.rejects(() => service.issue(VERIFIED, 'not-an-org-id', 'x'), TypeError);
});

test('service generates separate, hashed secrets, never passes raw token to repository', async () => {
  const seen: { issue?: Record<string, unknown>; redeem?: Record<string, unknown> } = {};
  const service = createAgentEnrollmentService(gateway({
    async issue(record) { seen.issue = { ...record }; return ENROLLMENT; },
    async redeem(record) { seen.redeem = { ...record }; return { organizationId: ORG_A, agentId: AGENT }; },
  }));
  const issued = await service.issue(VERIFIED, ORG_A, 'Host fleet');
  assert.equal(seen.issue?.tokenHash, hashAgentSecret(issued.oneTimeToken));
  assert.equal(seen.issue?.subject, VERIFIED.subject);
  assert.equal(JSON.stringify(seen.issue).includes(issued.oneTimeToken), false);
  const redeemed = await service.redeem(issued.oneTimeToken, AGENT_BODY as never);
  assert.equal(seen.redeem?.enrollmentHash, hashAgentSecret(issued.oneTimeToken));
  assert.equal(seen.redeem?.credentialHash, hashAgentSecret(redeemed.machineCredential));
  assert.notEqual(redeemed.machineCredential, issued.oneTimeToken);
  assert.equal(JSON.stringify(seen.redeem).includes(redeemed.machineCredential), false);
});

test('issue endpoint refuses missing verified identity before repository', async () => {
  let invoked = false;
  await serve(appFor(gateway({ async issue() { invoked = true; return ENROLLMENT; } }), null), async url => {
    const response = await post(`${url}/issue/${ORG_A}`, { label: 'Office' });
    assert.equal(response.status, 401);
    assert.equal(invoked, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('issue endpoint refuses mismatched organization, role override, wrong media before repository', async () => {
  let invoked = 0;
  await serve(appFor(gateway({ async issue() { invoked++; return ENROLLMENT; } })), async url => {
    assert.equal((await post(`${url}/issue/invalid`, { label: 'Office' })).status, 400);
    assert.equal((await post(`${url}/issue/${ORG_A}`, { label: 'Office', role: 'owner' })).status, 400);
    assert.equal((await post(`${url}/issue/${ORG_A}`, '{}', 'text/plain')).status, 415);
    assert.equal(invoked, 0);
  });
});

test('issue response delivers only the scoped one-time secret under no-store', async () => {
  await serve(appFor(gateway()), async url => {
    const response = await post(`${url}/issue/${ORG_A}`, { label: 'Office' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const json = await response.json();
    assert.deepEqual(Object.keys(json).sort(), ['enrollmentId', 'expiresAt', 'oneTimeToken', 'organizationId']);
    assert.equal(json.organizationId, ORG_A);
    assert.equal(hashAgentSecret(json.oneTimeToken).length, 64);
  });
});

test('issue endpoint gives generic access denial, no cross-tenant details', async () => {
  await serve(appFor(gateway({ async issue() { throw new EnrollmentPermissionDenied(); } })), async url => {
    const response = await post(`${url}/issue/${ORG_B}`, { label: 'Office' });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'organization_access_denied' });
  });
});

test('unexpected issue return or SQL failure is sanitized 503', async () => {
  for (const gw of [gateway({ async issue() { throw new Error('db secret password=should_not_leak'); } }),
    gateway({ async issue() { return 'not-a-uuid'; } })]) {
    await serve(appFor(gw), async url => {
      const response = await post(`${url}/issue/${ORG_A}`, { label: 'Office' });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'agent_enrollment_unavailable' });
      assert.equal(response.headers.get('retry-after'), '5');
    });
  }
});

test('redeem endpoint fails closed on malformed body before repository', async () => {
  let invoked = 0;
  await serve(appFor(gateway({ async redeem() { invoked++; return null; } })), async url => {
    assert.equal((await post(`${url}/redeem`, { token: 'not-a-token', agent: AGENT_BODY })).status, 400);
    assert.equal((await post(`${url}/redeem`, { token: createAgentSecretMaterial().oneTimeSecret, agent: AGENT_BODY, organizationId: ORG_A })).status, 400);
    assert.equal((await post(`${url}/redeem`, '{}', 'text/plain')).status, 415);
    assert.equal(invoked, 0);
  });
});

test('redeem endpoint provides server-generated credential with no browser-selected scope', async () => {
  const secret = createAgentSecretMaterial().oneTimeSecret;
  await serve(appFor(gateway()), async url => {
    const response = await post(`${url}/redeem`, { token: secret, agent: AGENT_BODY });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['agentId', 'machineCredential', 'organizationId']);
    assert.notEqual(result.machineCredential, secret);
    assert.equal(hashAgentSecret(result.machineCredential).length, 64);
  });
});

test('redeem treats absent, expired, used and revoked token uniformly', async () => {
  const secret = createAgentSecretMaterial().oneTimeSecret;
  for (const gw of [gateway({ async redeem() { return null; } }),
    gateway({ async redeem() { throw new EnrollmentNotAvailable(); } })]) {
    await serve(appFor(gw), async url => {
      const response = await post(`${url}/redeem`, { token: secret, agent: AGENT_BODY });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'enrollment_unavailable' });
    });
  }
});

test('redeem rejects malformed database responses and hides internal failures', async () => {
  const secret = createAgentSecretMaterial().oneTimeSecret;
  for (const gw of [gateway({ async redeem() { throw Error('SQL sensitive details'); } }),
    gateway({ async redeem() { return { organizationId: 'not-uuid', agentId: AGENT }; } })]) {
    await serve(appFor(gw), async url => {
      const response = await post(`${url}/redeem`, { token: secret, agent: AGENT_BODY });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'agent_enrollment_unavailable' });
    });
  }
});


test('accidentally mounted HTTP handlers refuse all requests without verified ingress marker', async () => {
  let invoked = false;
  const app = express();
  app.use(express.json({ limit: '2kb' }));
  const service = createAgentEnrollmentService(gateway({
    async issue() { invoked = true; return ENROLLMENT; },
    async redeem() { invoked = true; return { organizationId: ORG_A, agentId: AGENT }; },
  }));
  app.post('/issue/:organizationId', (_req, res, next) => {
    res.locals.authenticatedIdentity = VERIFIED;
    next();
  }, createIssueAgentEnrollmentRoute(service));
  app.post('/redeem', createRedeemAgentEnrollmentRoute(service));
  await serve(app, async url => {
    const issue = await post(`${url}/issue/${ORG_A}`, { label: 'Test' });
    assert.equal(issue.status, 503);
    assert.deepEqual(await issue.json(), { error: 'agent_enrollment_disabled' });
    const redeem = await post(`${url}/redeem`, {
      token: createAgentSecretMaterial().oneTimeSecret, agent: AGENT_BODY,
    });
    assert.equal(redeem.status, 503);
    assert.deepEqual(await redeem.json(), { error: 'agent_enrollment_disabled' });
    assert.equal(invoked, false);
  });
});
