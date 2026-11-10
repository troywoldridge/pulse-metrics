import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createInvitationAcceptanceService,
  isCanonicalInvitationToken,
  InvitationAcceptanceUnavailableError,
  InvitationNotAvailableError,
  type InvitationAcceptanceResult,
} from './auth/invitation-acceptance-service.js';
import type { AuthenticatedIdentity } from './auth/workos-auth.js';

const identity: AuthenticatedIdentity = {
  provider: 'workos', subject: 'user_redeem_test_123', sessionId: 'session_123',
};
const TOKEN = Buffer.alloc(32, 23).toString('base64url');
const DIGEST = createHash('sha256').update(TOKEN).digest('hex');
const ORG = 'a02c78a6-380d-444c-a2c9-87b76d328901';
const accepted: InvitationAcceptanceResult = { organizationId: ORG, membershipRole: 'viewer' };

test('acceptance uses only verified subject, fresh email and SHA-256 of raw secret', async () => {
  const calls: string[] = [];
  const service = createInvitationAcceptanceService({
    lookup: async actual => {
      calls.push('lookup');
      assert.equal(actual.subject, identity.subject);
      return 'recipient@example.invalid';
    },
    execute: async (subject, email, digest) => {
      calls.push('transaction');
      assert.equal(subject, identity.subject);
      assert.equal(email, 'recipient@example.invalid');
      assert.equal(digest, DIGEST);
      assert.notEqual(digest, TOKEN);
      return accepted;
    },
  });
  assert.deepEqual(await service(identity, TOKEN), accepted);
  assert.deepEqual(calls, ['lookup', 'transaction']);
});

test('explicitly unverified email clears database evidence, never grants membership', async () => {
  let called = false;
  const service = createInvitationAcceptanceService({
    lookup: async () => null,
    execute: async (_, email, digest) => {
      called = true;
      assert.equal(email, null);
      assert.equal(digest, DIGEST);
      return null;
    },
  });
  await assert.rejects(service(identity, TOKEN), InvitationNotAvailableError);
  assert.equal(called, true);
});

test('provider outage fails closed before any database operation', async () => {
  let executed = false;
  const service = createInvitationAcceptanceService({
    lookup: async () => { throw Error('private provider credentials'); },
    execute: async () => { executed = true; return accepted; },
  });
  await assert.rejects(service(identity, TOKEN), error =>
    error instanceof InvitationAcceptanceUnavailableError &&
    !error.message.includes('credentials'));
  assert.equal(executed, false);
});

test('malformed verified email cannot reach persistence', async () => {
  for (const value of [' RECIPIENT@example.invalid ', 'bad.email', 'UPPER@example.invalid',
    'x@b..invalid', 'a'.repeat(321), undefined]) {
    let executed = false;
    const service = createInvitationAcceptanceService({
      lookup: async () => value as string,
      execute: async () => { executed = true; return accepted; },
    });
    await assert.rejects(service(identity, TOKEN), InvitationAcceptanceUnavailableError);
    assert.equal(executed, false);
  }
});

test('only canonical full-length raw tokens are accepted', async () => {
  assert.equal(isCanonicalInvitationToken(TOKEN), true);
  for (const bad of ['', TOKEN + 'x', TOKEN.slice(1), 'a'.repeat(43), 'abc',
    'a'.repeat(43) + '\n', 'x'.repeat(1000), DIGEST, null]) {
    assert.equal(isCanonicalInvitationToken(bad), false);
  }
});

test('bad tokens and invalid identities fail before provider and DB', async () => {
  let calls = 0;
  const service = createInvitationAcceptanceService({
    lookup: async () => { calls++; return 'recipient@example.invalid'; },
    execute: async () => { calls++; return accepted; },
  });
  await assert.rejects(service(identity, 'not-an-invite'), TypeError);
  for (const wrong of [
    { ...identity, subject: 'another-user' },
    { ...identity, subject: 'user_bad\nsubject' },
    { ...identity, sessionId: '' },
    { ...identity, provider: 'browser' },
  ]) {
    await assert.rejects(service(wrong as AuthenticatedIdentity, TOKEN), TypeError);
  }
  assert.equal(calls, 0);
});

test('invalid or used invitation is reported without membership details', async () => {
  const service = createInvitationAcceptanceService({
    lookup: async () => 'recipient@example.invalid',
    execute: async () => null,
  });
  await assert.rejects(service(identity, TOKEN), InvitationNotAvailableError);
});

test('database errors are sanitized', async () => {
  const service = createInvitationAcceptanceService({
    lookup: async () => 'recipient@example.invalid',
    execute: async () => { throw Error('db password and private SQL details'); },
  });
  await assert.rejects(service(identity, TOKEN), error =>
    error instanceof InvitationAcceptanceUnavailableError &&
    !error.message.includes('password'));
});

test('a malformed acceptance result cannot authorize a membership', async () => {
  for (const invalid of [
    { organizationId: 'not-a-uuid', membershipRole: 'viewer' },
    { organizationId: ORG, membershipRole: 'owner' },
    { organizationId: ORG, membershipRole: 'superadmin' },
  ]) {
    const service = createInvitationAcceptanceService({
      lookup: async () => 'recipient@example.invalid',
      execute: async () => invalid as InvitationAcceptanceResult,
    });
    await assert.rejects(service(identity, TOKEN), InvitationAcceptanceUnavailableError);
  }
});
