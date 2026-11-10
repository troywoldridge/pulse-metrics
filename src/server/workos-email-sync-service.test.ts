import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createVerifiedEmailSynchronizer,
  createTestableVerifiedEmailSynchronizer,
  VerifiedEmailSyncUnavailableError,
} from './auth/workos-email-sync-service.js';
import type { AuthenticatedIdentity } from './auth/workos-auth.js';

const identity: AuthenticatedIdentity = {
  provider: 'workos', subject: 'user_sync_test_01', sessionId: 'session_sync_test',
};
const id = 'a1db1b07-5872-43d0-9d7c-c9ae723bc8a2';

function setup(lookup: (identity: AuthenticatedIdentity) => Promise<string | null>) {
  const order: string[] = [];
  const writes: Array<{ subject: string; email: string | null }> = [];
  const run = createVerifiedEmailSynchronizer({
    lookup: async input => { order.push('lookup'); return lookup(input); },
    provision: async input => { order.push('provision'); assert.equal(input.subject, identity.subject); return id; },
    persist: async (subject, email) => {
      order.push('persist'); writes.push({ subject, email }); return id;
    },
  });
  return { run, order, writes };
}

test('verified email is persisted for only the verified bearer subject', async () => {
  const s = setup(async () => 'recipient@example.invalid');
  assert.deepEqual(await s.run(identity), { userId: id, verifiedEmail: 'recipient@example.invalid' });
  assert.deepEqual(s.writes, [{ subject: identity.subject, email: 'recipient@example.invalid' }]);
  assert.deepEqual(s.order, ['lookup', 'provision', 'persist']);
});

test('explicit unverified WorkOS record clears stale email evidence', async () => {
  const s = setup(async () => null);
  assert.deepEqual(await s.run(identity), { userId: id, verifiedEmail: null });
  assert.deepEqual(s.writes, [{ subject: identity.subject, email: null }]);
});

test('WorkOS API outage causes zero provisioning and zero database writes', async () => {
  const s = setup(async () => { throw new Error('secret-bearing provider diagnostic'); });
  await assert.rejects(s.run(identity), e => e instanceof VerifiedEmailSyncUnavailableError && !e.message.includes('secret-bearing'));
  assert.deepEqual(s.order, ['lookup']);
  assert.deepEqual(s.writes, []);
});

test('invalid identity is denied before WorkOS lookup and database access', async () => {
  const s = setup(async () => 'recipient@example.invalid');
  for (const bad of [
    { ...identity, subject: 'other-user' },
    { ...identity, sessionId: '' },
    { ...identity, provider: 'browser' },
    { ...identity, subject: 'user_unsafe\n' },
  ]) {
    await assert.rejects(s.run(bad as AuthenticatedIdentity), TypeError);
  }
  assert.deepEqual(s.order, []);
});

test('malformed provider email cannot reach persistence', async () => {
  for (const bad of ['BAD@EXAMPLE.INVALID', ' bad@example.invalid ',
    'not-email', 'a@example.invalid\n', 'a'.repeat(321), undefined]) {
    const s = setup(async () => bad as string);
    await assert.rejects(s.run(identity), VerifiedEmailSyncUnavailableError);
    assert.deepEqual(s.writes, []);
  }
});

test('an identity lookup error never falls back to a cached verified email', async () => {
  const s = setup(async () => { throw Error('upstream timeout'); });
  await assert.rejects(s.run(identity), VerifiedEmailSyncUnavailableError);
  assert.deepEqual(s.order, ['lookup']);
});

test('provisioning failure prevents persistence', async () => {
  let wrote = false;
  const run = createVerifiedEmailSynchronizer({
    lookup: async () => 'recipient@example.invalid',
    provision: async () => { throw Error('database unavailable'); },
    persist: async () => { wrote = true; return id; },
  });
  await assert.rejects(run(identity), VerifiedEmailSyncUnavailableError);
  assert.equal(wrote, false);
});

test('persistence failure is sanitized', async () => {
  const run = createVerifiedEmailSynchronizer({
    lookup: async () => 'recipient@example.invalid',
    provision: async () => id,
    persist: async () => { throw new Error('private SQL details'); },
  });
  await assert.rejects(run(identity), e => e instanceof VerifiedEmailSyncUnavailableError && !e.message.includes('private'));
});

test('database returning a mismatched user id fails closed', async () => {
  const run = createVerifiedEmailSynchronizer({
    lookup: async () => 'recipient@example.invalid',
    provision: async () => id,
    persist: async () => 'b245602a-1b54-4c62-b514-aed86062146c',
  });
  await assert.rejects(run(identity), VerifiedEmailSyncUnavailableError);
});

test('database returning malformed provisioned user id fails closed before write', async () => {
  let wrote = false;
  const run = createVerifiedEmailSynchronizer({
    lookup: async () => 'recipient@example.invalid',
    provision: async () => 'nope',
    persist: async () => { wrote = true; return id; },
  });
  await assert.rejects(run(identity), VerifiedEmailSyncUnavailableError);
  assert.equal(wrote, false);
});

test('trusted WorkOS profile adapter rejects mismatched provider subject', async () => {
  let writes = 0;
  const run = createTestableVerifiedEmailSynchronizer(
    async () => ({ id: 'user_attacker', email: 'recipient@example.invalid', emailVerified: true }),
    async () => id,
    async () => { writes++; return id; },
  );
  await assert.rejects(run(identity), VerifiedEmailSyncUnavailableError);
  assert.equal(writes, 0);
});

test('trusted WorkOS profile adapter clears evidence on unverified account', async () => {
  const writes: Array<string | null> = [];
  const run = createTestableVerifiedEmailSynchronizer(
    async () => ({ id: identity.subject, email: 'recipient@example.invalid', emailVerified: false }),
    async () => id,
    async (_, email) => { writes.push(email); return id; },
  );
  assert.deepEqual(await run(identity), { userId: id, verifiedEmail: null });
  assert.deepEqual(writes, [null]);
});
