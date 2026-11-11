import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { closeDatabase } from '../../src/db/client.js';
import { requireWorkOSUser, type TokenVerifier } from '../../src/server/auth/workos-auth.js';
import { createInvitationRateLimiter, consumePersistedInvitationBucket } from '../../src/server/security/invitation-rate-limit.js';
import { createInvitationRateLimitGuards } from '../../src/server/security/invitation-rate-limit-middleware.js';
import { parseTrustedProxyCidrs } from '../../src/server/security/trusted-client-address.js';
import { createInvitationIssuanceRoute } from '../../src/server/auth/invitation-issuance-route.js';

/** Test-only local HTTP app. Real restricted Postgres counters, synthetic JWT
 * and business operation. Never use this synthetic JWT verifier in server.ts. */
const key = process.env.PULSE_PROXY_TEST_KEY;
const subject = process.env.PULSE_PROXY_TEST_SUBJECT;
if (!key || !subject) throw Error('Missing test-only variables');
const org = 'a02c78a6-380d-444c-a2c9-87b76d328901';
const secret = Buffer.alloc(32, 23).toString('base64url');
const verify: TokenVerifier = async bearer => bearer === 'synthetic.issuer'
  ? { sub: subject, sid: 'synthetic-session', iss:'https://test.invalid', exp: Date.now()/1000+600 }
  : null;
const checks = createInvitationRateLimiter({ hmacKey:key, consume:consumePersistedInvitationBucket });
const guards = createInvitationRateLimitGuards({
  checks, networkMode:'trusted-proxy', production:false,
  trustedProxies:parseTrustedProxyCidrs('127.0.0.1/32'),
});
const app = express();
app.use(express.json({ limit:'8kb' }));
app.post('/api/organizations/:organizationId/invitations', guards.network('issue'));
app.use('/api', requireWorkOSUser(verify));
let issuanceCount = 0;
app.post('/api/organizations/:organizationId/invitations', guards.actor('issue'),
  createInvitationIssuanceRoute(async (_identity, organizationId, proposal) => {
    issuanceCount++;
    return {
      invitation: { id:'cbb8bedf-0605-4e13-91f8-c28e2f2a6606',
        organizationId, invitedEmail:proposal.email, invitedRole:proposal.role,
        expiresAt:new Date(Date.now()+60000).toISOString() },
      oneTimeToken:secret,
    };
  }),
);
const httpServer = createServer(app);
let endpoint = '';
function issue(xff?:string, bearer?:string, additional:Record<string,string>={}) {
  return fetch(endpoint, { method:'POST',
    headers:{ 'Content-Type':'application/json', ...(xff ? {'X-Forwarded-For':xff}:{}),
      ...(bearer? {Authorization:`Bearer ${bearer}`} : {}), ...additional },
    body:JSON.stringify({email:'recipient@example.invalid',role:'viewer'}),
  });
}

test('real HTTP and restricted PostgreSQL: trusted proxy network identity', async t => {
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer,'listening');
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw Error('Invalid listener');
  endpoint = `http://127.0.0.1:${address.port}/api/organizations/${org}/invitations`;
  try {
    await t.test('missing or malformed forwarded chain fails before a DB write', async () => {
      assert.equal((await issue()).status, 503);
      assert.equal((await issue('unknown')).status, 503);
      assert.equal((await issue('127.0.0.1')).status, 503);
    });
    await t.test('actor quota applies to real proxy-resolved client A', async () => {
      for (let i=0;i<10;i++) {
        assert.equal((await issue('198.51.100.11','synthetic.issuer')).status,201);
      }
      const response = await issue('203.0.113.99, 198.51.100.11','synthetic.issuer',{
        'X-Real-IP':'203.0.113.4', Forwarded:'for=203.0.113.5',
      });
      assert.equal(response.status,429);
      assert.equal(issuanceCount,10);
      assert.deepEqual(await response.json(),{error:'invitation_rate_limited'});
    });
    await t.test('forged leftmost hops cannot bypass client A network quota', async () => {
      for (let i=0;i<49;i++) {
        assert.equal((await issue(`203.0.113.${(i%199)+1}, 198.51.100.11`)).status,401);
      }
      const response = await issue('192.0.2.99, 198.51.100.11');
      assert.equal(response.status,429);
      assert.equal(issuanceCount,10);
    });
    await t.test('a second client has a separate network quota',async()=>{
      assert.equal((await issue('198.51.100.22')).status,401);
    });
    await t.test('two IPv6 spellings share the same persistent network bucket',async()=>{
      assert.equal((await issue('2001:0DB8:0:0:0:0:0:1')).status,401);
      assert.equal((await issue('2001:db8::1')).status,401);
    });
    console.log('PASS: trusted-proxy HTTP client identity reaches restricted PostgreSQL buckets');
  } finally {
    await new Promise<void>((resolve,reject)=>httpServer.close(e=>e?reject(e):resolve()));
    await closeDatabase();
  }
});
