import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  assertExpectedMachineIdentity,
  isCanonicalMachineSecret,
  parseMachineIdentity,
} from './machine-identity.js';

const organizationId = 'a9827cff-c4a4-4c36-8ec0-dae0e9933d08';
const agentId = '153bd92f-47c4-4de2-95e0-a042ea8bcb3a';
const fresh = () => randomBytes(32).toString('base64url');
const receipt = () => ({ organizationId, agentId, machineCredential: fresh() });

test('accepts a canonical 32-byte secret and exact enrollment response contract', () => {
  const value = receipt();
  assert.equal(isCanonicalMachineSecret(value.machineCredential), true);
  assert.deepEqual(parseMachineIdentity(value), value);
  assert.equal(Object.isFrozen(parseMachineIdentity(value)), true);
});

test('refuses short, padded, noncanonical and non-string machine credentials', () => {
  const value = receipt();
  for (const invalid of [null, '', 'a'.repeat(43), 'a'.repeat(42),
    value.machineCredential + '=', value.machineCredential + '\n', 123]) {
    assert.equal(isCanonicalMachineSecret(invalid), false);
    assert.throws(() => parseMachineIdentity({ ...value, machineCredential: invalid }), TypeError);
  }
});

test('refuses injected fields, malformed UUIDs and non-objects', () => {
  const value = receipt();
  for (const invalid of [null, [], 'hello', { ...value, role: 'owner' },
    { ...value, organizationId: 'not-a-uuid' }, { ...value, agentId: undefined },
    { ...value, machineCredential: undefined }]) {
    assert.throws(() => parseMachineIdentity(invalid), TypeError);
  }
});

test('requires exact expected organization and agent; cannot silently switch tenants', () => {
  const value = receipt();
  assert.doesNotThrow(() => assertExpectedMachineIdentity(value, { organizationId, agentId }));
  assert.throws(() => assertExpectedMachineIdentity(value, {
    organizationId: 'f3802024-9d29-440d-9040-cd4f7e9fb471', agentId,
  }), TypeError);
  assert.throws(() => assertExpectedMachineIdentity(value, {
    organizationId, agentId: '39dd5203-7c2c-49c8-bf58-5c5190c47ea9',
  }), TypeError);
});

test('invalid receipt errors never include raw credential material', () => {
  const value = receipt();
  assert.throws(() => parseMachineIdentity({ ...value, platform: 'linux' }), (error: unknown) => {
    assert.equal(String(error).includes(value.machineCredential), false);
    return true;
  });
});
