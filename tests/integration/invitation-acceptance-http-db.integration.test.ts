import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import pg from 'pg';
import { closeDatabase } from '../../src/db/client.js';
import { requireWorkOSUser, type TokenVerifier } from '../../src/server/auth/workos-auth.js';
import { createVerifiedEmailLookup } from '../../src/server/auth/workos-verified-email.js';
import { createInvitationAcceptanceRoute } from '../../src/server/auth/invitation-acceptance-route.js';
import {
  createInvitationAcceptanceService,
  synchronizeAndAcceptInvitation,
} from '../../src/server/auth/invitation-acceptance-service.js';

/**
 * REAL Express + restricted PostgreSQL, with SYNTHETIC WorkOS identities.
 * Not a live WorkOS API integration test. Never mount this test handler in the
 * production server: it uses a synthetic JWT verifier and profile source.
 * Fixture creation/cleanup lives in the guarded Bash wrapper.
 */
const required = ['SUBJECT_OWNER_A', 'SUBJECT_OWNER_B', 'SUBJECT_RECIPIENT_A',
  'SUBJECT_RECIPIENT_B', 'SUBJECT_OUTSIDER', 'ORG_A', 'ORG_B', 'SUFFIX'] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing synthetic fixture identifier: ${key}`);
}
const {
  SUBJECT_OWNER_A: ownerA,
  SUBJECT_OWNER_B: ownerB,
  SUBJECT_RECIPIENT_A: recipientA,
  SUBJECT_RECIPIENT_B: recipientB,
  SUBJECT_OUTSIDER: outsider,
  ORG_A: orgA,
  ORG_B: orgB,
  SUFFIX: suffix,
} = process.env as Record<typeof required[number], string>;

const emailA = `recipient-a.${suffix}@example.invalid`;
const changedA = `changed-a.${suffix}@example.invalid`;
const emailB = `recipient-b.${suffix}@example.invalid`;
const emailOutsider = `outsider.${suffix}@example.invalid`;
const userProfiles = new Map<string, { email: string; emailVerified: boolean }>([
  [recipientA, { email: emailA, emailVerified: true }],
  [recipientB, { email: emailB, emailVerified: true }],
  [outsider, { email: emailOutsider, emailVerified: true }],
]);
const bearerSubjects: Record<string, string> = {
  'recipient-a.test': recipientA,
  'recipient-b.test': recipientB,
  'outsider.test': outsider,
};
const verify: TokenVerifier = async bearer => {
  const sub = Object.prototype.hasOwnProperty.call(bearerSubjects, bearer)
    ? bearerSubjects[bearer] : undefined;
  return sub ? { sub, sid: 'synthetic-session',
    iss: 'https://synthetic.invalid', exp: Date.now() / 1000 + 1200 } : null;
};
const missing = Symbol('missing');
let providerOutageFor: string | null = null;
let providerLookups = 0;
let serviceAttempts = 0;
const lookup = createVerifiedEmailLookup(async subject => {
  providerLookups++;
  if (providerOutageFor === subject) throw new Error('INTERNAL_WORKOS_API_SECRET_SHOULD_NOT_LEAK');
  const profile = userProfiles.get(subject);
  if (!profile) return missing;
  return { id: subject, email: profile.email, emailVerified: profile.emailVerified };
});
const realAcceptor = createInvitationAcceptanceService({
  lookup,
  execute: synchronizeAndAcceptInvitation,
});
const app = express();
app.use(express.json({ limit: '8kb' }));
app.use('/api', requireWorkOSUser(verify));
app.post('/api/invitations/accept', createInvitationAcceptanceRoute(async (identity, token) => {
  serviceAttempts++;
  return realAcceptor(identity, token);
}));
const server: Server = createServer(app);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
let url: string;
const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function post(subject: keyof typeof bearerSubjects, body: unknown, type = 'application/json') {
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${subject}`, 'Content-Type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function issue(owner: string, org: string, email: string, token: string) {
  const result = await client.query(
    'SELECT public.issue_organization_invitation($1,$2,$3,$4,$5,$6) AS id',
    [owner, org, email, 'viewer', digest(token), new Date(Date.now() + 24 * 3600_000)],
  );
  assert.match(result.rows[0]?.id, /^[0-9a-f-]{36}$/);
}
async function generic404(res: Response) {
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { error: 'invitation_unavailable' });
}

// A single top-level test and ordered subtests ensure no concurrency between
// test-state mutations; only the explicitly concurrent requests race.
test('REAL HTTP + PostgreSQL invitation acceptance security (synthetic WorkOS)', async t => {
  await client.connect();
  const role = await client.query('SELECT current_user AS role');
  assert.equal(role.rows[0]?.role, 'pulse_metrics_app');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Test listener failed');
  url = `http://127.0.0.1:${address.port}/api/invitations/accept`;
  try {
    const tokenA = secret();
    const tokenB = secret();
    const duplicateA = secret();
    await issue(ownerA, orgA, emailA, tokenA);
    await issue(ownerA, orgA, emailA, duplicateA);
    await issue(ownerB, orgB, emailB, tokenB);

    await t.test('unauthenticated bearer is rejected before provider and database', async () => {
      const before = [serviceAttempts, providerLookups];
      const response = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenA }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual([serviceAttempts, providerLookups], before);
    });

    await t.test('invalid bearer cannot reach provider or database', async () => {
      const before = [serviceAttempts, providerLookups];
      const response = await post('invalid.test', { token: tokenA });
      assert.equal(response.status, 401);
      assert.deepEqual([serviceAttempts, providerLookups], before);
    });

    await t.test('non-JSON and browser identity/role overrides are blocked', async () => {
      const before = serviceAttempts;
      assert.equal((await post('recipient-a.test', '{"token":"x"}', 'text/plain')).status, 415);
      for (const injected of [
        { email: emailB }, { role: 'owner' }, { organizationId: orgB },
        { subject: recipientB }, { tokenHash: digest(tokenA) },
      ]) {
        const response = await post('recipient-a.test', { token: tokenA, ...injected });
        assert.equal(response.status, 400);
      }
      const invalid = await post('recipient-a.test', { token: digest(tokenA) });
      assert.equal(invalid.status, 400);
      assert.equal(serviceAttempts, before);
    });

    await t.test('unknown token returns generic 404 without leaking metadata', async () => {
      await generic404(await post('recipient-a.test', { token: secret() }));
    });

    await t.test('wrong recipient cannot accept an invitation', async () => {
      await generic404(await post('outsider.test', { token: tokenA }));
      await generic404(await post('recipient-a.test', { token: tokenB }));
    });

    await t.test('changed WorkOS email blocks the old invitation', async () => {
      userProfiles.set(recipientA, { email: changedA, emailVerified: true });
      await generic404(await post('recipient-a.test', { token: tokenA }));
    });

    await t.test('unverified WorkOS email clears stale evidence and denies', async () => {
      userProfiles.set(recipientA, { email: emailA, emailVerified: false });
      await generic404(await post('recipient-a.test', { token: tokenA }));
    });

    await t.test('provider outage returns sanitized 503 and does not redeem', async () => {
      userProfiles.set(recipientA, { email: emailA, emailVerified: true });
      providerOutageFor = recipientA;
      try {
        const res = await post('recipient-a.test', { token: tokenA });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await res.json(), { error: 'invitation_acceptance_unavailable' });
      } finally {
        providerOutageFor = null;
      }
    });

    await t.test('verified intended recipient accepts only once', async () => {
      const response = await post('recipient-a.test', { token: tokenA });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), {
        organizationId: orgA, membershipRole: 'viewer',
      });
      await generic404(await post('recipient-a.test', { token: tokenA }));
    });

    await t.test('existing membership cannot be overwritten or promoted', async () => {
      await generic404(await post('recipient-a.test', { token: duplicateA }));
    });

    await t.test('two concurrent requests result in one acceptance only', async () => {
      const results = await Promise.all([
        post('recipient-b.test', { token: tokenB }),
        post('recipient-b.test', { token: tokenB }),
      ]);
      assert.deepEqual(results.map(res => res.status).sort(), [200, 404]);
      for (const res of results) {
        const body = await res.json();
        if (res.status === 200) {
          assert.deepEqual(body, { organizationId: orgB, membershipRole: 'viewer' });
        } else {
          assert.deepEqual(body, { error: 'invitation_unavailable' });
        }
      }
    });
    console.log('PASS: test HTTP authorization, trusted WorkOS boundary and PostgreSQL integrity');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await client.end();
    await closeDatabase();
  }
});
