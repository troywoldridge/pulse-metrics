/**
 * Phase 2E3B database-backed HTTP tests. Uses a synthetic JWT verifier but
 * the actual Express handler, issuance service, restricted app role and SQL.
 * Never prints or persists raw bearer strings or invitation secrets.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from '../../src/server/auth/workos-auth.js';
import { createInvitationIssuanceRoute } from '../../src/server/auth/invitation-issuance-route.js';
import { closeDatabase } from '../../src/db/client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const orgA = required('PULSE_INVITE_LIVE_ORG_A');
const orgB = required('PULSE_INVITE_LIVE_ORG_B');
const unique = required('PULSE_INVITE_LIVE_SUFFIX');
const auditFile = required('PULSE_INVITE_AUDIT_FILE');
const subjects = {
  ownerA: required('PULSE_INVITE_LIVE_OWNER_A'),
  adminA: required('PULSE_INVITE_LIVE_ADMIN_A'),
  memberA: required('PULSE_INVITE_LIVE_MEMBER_A'),
  viewerA: required('PULSE_INVITE_LIVE_VIEWER_A'),
  ownerB: required('PULSE_INVITE_LIVE_OWNER_B'),
  outsider: required('PULSE_INVITE_LIVE_OUTSIDER'),
};
function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
assert.match(orgA, UUID);
assert.match(orgB, UUID);
assert.match(unique, /^[a-f0-9]{20}$/);
for (const subject of Object.values(subjects)) assert.match(subject, /^user_[A-Za-z0-9_-]+$/);

const verify: TokenVerifier = async token => {
  // Synthetic test-only mapping; no WorkOS token or signing key is involved.
  if (!Object.prototype.hasOwnProperty.call(subjects, token)) return null;
  return { sub: subjects[token as keyof typeof subjects], sid: 'session_local_fixture',
    iss: 'https://test.invalid', exp: 4102444800 };
};

let appServer: Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api', requireWorkOSUser(verify));
  app.post('/api/organizations/:organizationId/invitations', createInvitationIssuanceRoute());
  appServer = createServer(app);
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const address = appServer.address();
  if (!address || typeof address === 'string') throw new Error('No test listen address');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (appServer?.listening) await new Promise<void>((resolve, reject) =>
    appServer.close(error => error ? reject(error) : resolve()));
  await closeDatabase();
});

function post(role: string, organizationId: string = orgA,
  invitedRole: string = 'viewer', email: string = `live-${unique}@example.invalid`,
  extra?: Record<string, unknown>) {
  return fetch(`${base}/api/organizations/${organizationId}/invitations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${role}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, role: invitedRole, ...extra }),
  });
}
const createdHashes = new Set<string>();
async function expectCreated(response: Response, role: string, org: string, email: string) {
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as {
    invitation: { id: string; organizationId: string; invitedEmail: string;
      invitedRole: string; expiresAt: string }; oneTimeToken: string;
  };
  assert.match(body.invitation.id, UUID);
  assert.equal(body.invitation.organizationId, org);
  assert.equal(body.invitation.invitedEmail, email);
  assert.equal(body.invitation.invitedRole, role);
  const delta = Date.parse(body.invitation.expiresAt) - Date.now();
  assert.ok(delta > 23 * 60 * 60 * 1000 && delta < 25 * 60 * 60 * 1000);
  assert.match(body.oneTimeToken, /^[A-Za-z0-9_-]{43}$/);
  const hash = digest(body.oneTimeToken);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(!createdHashes.has(hash), 'token digests must be unique');
  createdHashes.add(hash);
  // Safe audit data: only the SHA-256 digest and invitation UUID are written.
  appendFileSync(auditFile, `${body.invitation.id} ${hash}\n`, { mode: 0o600 });
}
async function expectDenied(response: Response, status: number) {
  assert.equal(response.status, status);
  const text = await response.text();
  assert.doesNotMatch(text, /oneTimeToken|token_hash|SELECT|auth_subject|session_local_fixture/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

test('missing bearer is rejected before invitation issuance', async () => {
  const response = await fetch(`${base}/api/organizations/${orgA}/invitations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `empty-${unique}@example.invalid`, role: 'member' }),
  });
  await expectDenied(response, 401);
});
test('invalid bearer is rejected before invitation issuance', async () => {
  await expectDenied(await post('fakeUser', orgA), 401);
});
test('invalid organization UUID is rejected', async () => {
  await expectDenied(await post('ownerA', 'not-a-uuid'), 400);
});
test('browser cannot supply owner role or override actor', async () => {
  await expectDenied(await post('ownerA', orgA, 'owner'), 400);
  await expectDenied(await post('ownerA', orgA, 'member', `bad-${unique}@example.invalid`,
    { userId: 'forged' }), 400);
  await expectDenied(await post('ownerA', orgA, 'member', `bad-${unique}@example.invalid`,
    { tokenHash: 'a'.repeat(64) }), 400);
});
test('owner A can issue a genuine admin invitation', async () => {
  const email = `admin-${unique}@example.invalid`;
  await expectCreated(await post('ownerA', orgA, 'admin', email), 'admin', orgA, email);
});
test('admin A can issue a genuine viewer invitation', async () => {
  const email = `viewer-${unique}@example.invalid`;
  await expectCreated(await post('adminA', orgA, 'viewer', email), 'viewer', orgA, email);
});
test('admin A cannot issue an admin invitation', async () => {
  await expectDenied(await post('adminA', orgA, 'admin'), 403);
});
test('members and viewers cannot issue invitations', async () => {
  await expectDenied(await post('memberA', orgA), 403);
  await expectDenied(await post('viewerA', orgA), 403);
});
test('an unaffiliated identity cannot issue invitations', async () => {
  await expectDenied(await post('outsider', orgA), 403);
});
test('owner A cannot issue an invitation in organization B', async () => {
  await expectDenied(await post('ownerA', orgB), 403);
});
test('owner B cannot issue an invitation in organization A', async () => {
  await expectDenied(await post('ownerB', orgA), 403);
});
test('owner B can issue a genuine member invitation in B', async () => {
  const email = `b-${unique}@example.invalid`;
  await expectCreated(await post('ownerB', orgB, 'member', email), 'member', orgB, email);
});
test('two valid invitations receive different random tokens', async () => {
  const email = `second-${unique}@example.invalid`;
  await expectCreated(await post('ownerA', orgA, 'member', email), 'member', orgA, email);
  assert.equal(createdHashes.size, 4);
});
