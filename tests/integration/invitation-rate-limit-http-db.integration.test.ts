import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { closeDatabase } from '../../src/db/client.js';
import { requireWorkOSUser, type TokenVerifier } from '../../src/server/auth/workos-auth.js';
import { createInvitationRateLimitGuards } from '../../src/server/security/invitation-rate-limit-middleware.js';
import { createInvitationRateLimiter, consumePersistedInvitationBucket } from '../../src/server/security/invitation-rate-limit.js';
import { createInvitationIssuanceRoute } from '../../src/server/auth/invitation-issuance-route.js';
import { createInvitationAcceptanceRoute } from '../../src/server/auth/invitation-acceptance-route.js';

// LOCAL-ONLY test. Synthetic bearer validation, synthetic issuance/acceptance;
// real shared PostgreSQL quotas through pulse_metrics_app. No real memberships
// or invitations are created; this tests the HTTP *limiter wiring* only.
for (const key of ['PULSE_RATE_TEST_KEY', 'PULSE_RATE_TEST_ISSUER', 'PULSE_RATE_TEST_RECIPIENT']) {
  if (!process.env[key]) throw new Error(`Missing test-only variable: ${key}`);
}
const issuer = process.env.PULSE_RATE_TEST_ISSUER!;
const recipient = process.env.PULSE_RATE_TEST_RECIPIENT!;
const org = 'a02c78a6-380d-444c-a2c9-87b76d328901';
const token = Buffer.alloc(32, 14).toString('base64url');
let issueCalls = 0;
let acceptCalls = 0;
let verificationCalls = 0;
const verifier: TokenVerifier = async bearer => {
  verificationCalls++;
  const subject = bearer === 'issuer.test' ? issuer : bearer === 'recipient.test' ? recipient : null;
  return subject ? { sub: subject, sid: 'synthetic_rate_limit_session',
    iss: 'https://synthetic.invalid', exp: Date.now() / 1000 + 600 } : null;
};
const checks = createInvitationRateLimiter({
  hmacKey: process.env.PULSE_RATE_TEST_KEY!, consume: consumePersistedInvitationBucket,
});
const guards = createInvitationRateLimitGuards({ checks, networkMode: 'local-direct-socket', production: false });
const app = express();
app.use(express.json({ limit: '8kb' }));
// Production order: network before JWT, actor after verified JWT.
app.post('/api/organizations/:organizationId/invitations', guards.network('issue'));
app.post('/api/invitations/accept', guards.network('accept')); // Test app ONLY. Not mounted in server.ts.
app.use('/api', requireWorkOSUser(verifier));
app.post('/api/organizations/:organizationId/invitations',
  guards.actor('issue'),
  createInvitationIssuanceRoute(async (_identity, organizationId, proposal) => {
    issueCalls++;
    return {
      invitation: {
        id: 'b11a0189-6609-4890-a1c0-a71c438b1251',
        organizationId, invitedEmail: proposal.email, invitedRole: proposal.role,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      oneTimeToken: token,
    };
  }),
);
app.post('/api/invitations/accept', guards.actor('accept'),
  createInvitationAcceptanceRoute(async () => {
    acceptCalls++;
    return { organizationId: org, membershipRole: 'viewer' };
  }),
);
const server = createServer(app);
let origin = '';
const headers = (bearer: string | undefined, forwarding = '203.0.113.22') => ({
  'Content-Type': 'application/json',
  'X-Forwarded-For': forwarding,
  ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
});
const issue = (bearer?: string, forwarding?: string) => fetch(`${origin}/api/organizations/${org}/invitations`, {
  method: 'POST', headers: headers(bearer, forwarding),
  body: JSON.stringify({ email: 'recipient@example.invalid', role: 'viewer' }),
});
const accept = (bearer?: string) => fetch(`${origin}/api/invitations/accept`, {
  method: 'POST', headers: headers(bearer), body: JSON.stringify({ token }),
});

test('real Express rate-limit guards and restricted PostgreSQL quotas', async t => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing HTTP listener');
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await t.test('unauthenticated requests consume network quota but not actor quota', async () => {
      const before = verificationCalls;
      const res = await issue();
      assert.equal(res.status, 401);
      // Missing bearer must be rejected by requireWorkOSUser *without*
      // calling the verifier. The network guard still consumes one quota:
      // the later exhaustion test and the final SQL audit verify that count.
      assert.equal(verificationCalls, before);
      assert.equal(issueCalls, 0);
    });

    await t.test('valid issuance requests consume actor quota; 11th is 429', async () => {
      for (let i = 0; i < 10; i++) {
        const res = await issue('issuer.test');
        assert.equal(res.status, 201);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = await res.json() as { invitation: { organizationId:string } };
        assert.equal(body.invitation.organizationId, org);
      }
      const res = await issue('issuer.test');
      assert.equal(res.status, 429);
      assert.deepEqual(await res.json(), { error: 'invitation_rate_limited' });
      assert.match(res.headers.get('retry-after') ?? '', /^\d+$/);
      assert.equal(issueCalls, 10);
    });

    await t.test('network quota cannot be bypassed by spoofing X-Forwarded-For', async () => {
      // Already 12 network requests (1 missing bearer + 11 valid bearer).
      for (let i = 0; i < 48; i++) {
        const res = await issue(undefined, `198.51.100.${(i % 200) + 1}`);
        assert.equal(res.status, 401);
      }
      const before = verificationCalls;
      const denied = await issue(undefined, '192.0.2.222');
      assert.equal(denied.status, 429);
      assert.equal(verificationCalls, before); // Network guard precedes WorkOS.
      assert.equal(issueCalls, 10);
    });

    await t.test('acceptance uses a distinct action quota; 21st actor call is 429', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await accept('recipient.test');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { organizationId: org, membershipRole: 'viewer' });
      }
      const denied = await accept('recipient.test');
      assert.equal(denied.status, 429);
      assert.deepEqual(await denied.json(), { error: 'invitation_rate_limited' });
      assert.equal(acceptCalls, 20);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await closeDatabase();
  }
});
