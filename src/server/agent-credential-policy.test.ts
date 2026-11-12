import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentSecretMaterial, createEnrollmentMaterial, ENROLLMENT_LIFETIME_MS,
  hashAgentSecret, isCanonicalSecret, isSha256Digest, isVerifiedActor,
  isValidOrganizationId, parseAgentDescription,
} from './agent-credential-policy.js';

test('enrollment secret uses 32 secure random bytes and canonical 43-char URL-safe base64', () => {
  const a = createEnrollmentMaterial(1_800_000_000_000);
  const b = createEnrollmentMaterial(1_800_000_000_000);
  assert.notEqual(a.oneTimeSecret, b.oneTimeSecret);
  assert.equal(isCanonicalSecret(a.oneTimeSecret), true);
  assert.equal(a.oneTimeSecret.length, 43);
  assert.equal(a.expiresAt, new Date(1_800_000_000_000 + ENROLLMENT_LIFETIME_MS).toISOString());
});

test('hash is deterministic SHA-256 and prefix is derived from digest not secret', () => {
  const x = createAgentSecretMaterial();
  assert.equal(hashAgentSecret(x.oneTimeSecret), x.tokenHash);
  assert.equal(x.tokenPrefix, x.tokenHash.slice(0, 12));
  assert.equal(isSha256Digest(x.tokenHash), true);
  assert.equal(x.tokenPrefix.length, 12);
  assert.equal(x.oneTimeSecret.includes(x.tokenPrefix), false);
});

test('invalid, truncated, padded and noncanonical secrets are refused', () => {
  const x = createAgentSecretMaterial().oneTimeSecret;
  for (const value of [null, undefined, '', x.slice(0, -1), x + '=', x + '\n', x.toUpperCase() + '+', 'a'.repeat(43), 'a'.repeat(44), '%%%%', '0'.repeat(64)]) {
    assert.equal(isCanonicalSecret(value), false, String(value));
    assert.throws(() => hashAgentSecret(value), TypeError);
  }
});

test('digest format is exact lowercase SHA-256', () => {
  const x = createAgentSecretMaterial().tokenHash;
  assert.equal(isSha256Digest(x.toUpperCase()), false);
  assert.equal(isSha256Digest(x.slice(1)), false);
  assert.equal(isSha256Digest(x), true);
});

test('enrollment expiry refuses nonfinite, fractional and out-of-range time', () => {
  for (const value of [NaN, Infinity, -1, 1.25, 9_000_000_000_000_000]) {
    assert.throws(() => createEnrollmentMaterial(value), TypeError);
  }
});

test('verified actor cannot be supplied by untrusted identity shape', () => {
  const actor = { provider: 'workos', subject: 'user_agent_owner', sessionId: 'sid_123' };
  assert.equal(isVerifiedActor(actor), true);
  for (const x of [null, { ...actor, provider: 'agent' }, { ...actor, subject: 'owner' },
    { ...actor, subject: 'user_!' }, { ...actor, sessionId: '' }]) assert.equal(isVerifiedActor(x), false);
});

test('organization identifiers must be UUIDs', () => {
  assert.equal(isValidOrganizationId('00000000-0000-4000-8000-000000000001'), true);
  assert.equal(isValidOrganizationId('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(isValidOrganizationId('../org'), false);
});

test('agent identity proposal accepts only explicit Linux details, never SSH or credentials', () => {
  const good = { displayName: ' Host 1 ', hostname: 'host-1.example.invalid', platform: 'linux', architecture: 'x86_64' };
  assert.deepEqual(parseAgentDescription(good), { ...good, displayName: 'Host 1' });
  assert.equal(parseAgentDescription({ ...good, sshCommand: 'ssh server' }), null);
  assert.equal(parseAgentDescription({ ...good, organizationId: 'abc' }), null);
  assert.equal(parseAgentDescription({ ...good, architecture: 'mips' }), null);
  assert.equal(parseAgentDescription({ ...good, displayName: 'x\nhello' }), null);
  assert.equal(parseAgentDescription({ ...good, hostname: 'bad host' }), null);
  assert.equal(parseAgentDescription({ ...good, platform: 'windows' }), null);
});
