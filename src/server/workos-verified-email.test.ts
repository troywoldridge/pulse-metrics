import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createVerifiedEmailLookup,
  createLiveWorkOSVerifiedEmailLookup,
  VerifiedEmailEvidenceUnavailableError,
} from './auth/workos-verified-email.js';
import type { AuthenticatedIdentity } from './auth/workos-auth.js';

const identity: AuthenticatedIdentity = {
  provider: 'workos',
  subject: 'user_test_verified_123',
  sessionId: 'session_test',
};
const verifiedProfile = {
  id: identity.subject,
  email: 'Recipient@Example.com',
  emailVerified: true,
};

const mustFail = async (profile: unknown) => {
  const resolve = createVerifiedEmailLookup(async () => profile);
  await assert.rejects(resolve(identity), VerifiedEmailEvidenceUnavailableError);
};

test('verified WorkOS email is normalized, never taken from caller input', async () => {
  let lookedUp: string | undefined;
  const resolve = createVerifiedEmailLookup(async subject => {
    lookedUp = subject;
    return { ...verifiedProfile, email: '  RECIPIENT@EXAMPLE.COM  ' };
  });
  assert.equal(await resolve(identity), 'recipient@example.com');
  assert.equal(lookedUp, identity.subject);
});

test('explicitly unverified WorkOS account returns no acceptance evidence', async () => {
  const resolve = createVerifiedEmailLookup(async () => ({
    ...verifiedProfile, emailVerified: false,
  }));
  assert.equal(await resolve(identity), null);
});

test('missing emailVerified flag fails closed', async () => {
  await mustFail({ id: identity.subject, email: 'recipient@example.com' });
});

test('string instead of boolean emailVerified fails closed', async () => {
  await mustFail({ ...verifiedProfile, emailVerified: 'true' });
});

test('profile belonging to another WorkOS subject is rejected', async () => {
  await mustFail({ ...verifiedProfile, id: 'user_another' });
});

test('profile missing user ID is rejected', async () => {
  await mustFail({ email: 'recipient@example.com', emailVerified: true });
});

test('verified account without a usable email is rejected', async () => {
  await mustFail({ ...verifiedProfile, email: null });
});

test('malformed verified emails are rejected', async () => {
  for (const email of ['', 'not-an-email', 'a@b', 'a@b..com',
    'a@b.com\r\nheader:value', 'a'.repeat(321) + '@example.com']) {
    await mustFail({ ...verifiedProfile, email });
  }
});

test('null API profile is rejected', async () => { await mustFail(null); });

test('WorkOS management API outages are sanitized', async () => {
  const resolve = createVerifiedEmailLookup(async () => {
    throw new Error('private WorkOS API response with credentials');
  });
  await assert.rejects(resolve(identity), error =>
    error instanceof VerifiedEmailEvidenceUnavailableError &&
    !error.message.includes('credentials'));
});

test('caller cannot override a verified subject or session', async () => {
  let lookups = 0;
  const resolve = createVerifiedEmailLookup(async () => {
    lookups++;
    return verifiedProfile;
  });
  for (const invalid of [
    { ...identity, provider: 'browser' },
    { ...identity, subject: 'user_unsafe\nsubject' },
    { ...identity, subject: 'other_user' },
    { ...identity, sessionId: '' },
    { ...identity, subject: 'a'.repeat(256) },
  ]) {
    await assert.rejects(resolve(invalid as AuthenticatedIdentity), TypeError);
  }
  assert.equal(lookups, 0);
});

test('missing server-only WorkOS API key fails closed without making requests', () => {
  assert.throws(() => createLiveWorkOSVerifiedEmailLookup({
    WORKOS_CLIENT_ID: 'client_test',
    WORKOS_TOKEN_ISSUER: 'https://api.workos.com/user_management/client_test',
  }), /server-only WORKOS_API_KEY/);
});

test('invalid client/issuer configuration is rejected', () => {
  const base = {
    WORKOS_API_KEY: 'sk_test_example_only',
    WORKOS_CLIENT_ID: 'client_test',
    WORKOS_TOKEN_ISSUER: 'https://api.workos.com/user_management/client_test',
  };
  assert.throws(() => createLiveWorkOSVerifiedEmailLookup({ ...base, WORKOS_CLIENT_ID: '' }), /WORKOS_CLIENT_ID/);
  assert.throws(() => createLiveWorkOSVerifiedEmailLookup({ ...base, WORKOS_TOKEN_ISSUER: 'http://localhost/' }), /HTTPS issuer/);
});
