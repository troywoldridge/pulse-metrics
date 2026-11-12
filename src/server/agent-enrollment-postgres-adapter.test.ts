import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresEnrollmentGateway, type EnrollmentSqlExecutor } from './agent-enrollment-postgres-adapter.js';
import { createAgentSecretMaterial } from './agent-credential-policy.js';
import { EnrollmentNotAvailable, EnrollmentPermissionDenied } from './agent-enrollment-service.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const identity = { provider: 'workos' as const, subject: 'user_test', sessionId: 'session' };
const description = { displayName: 'Linux host', hostname: 'host.invalid', platform: 'linux' as const,
  architecture: 'x86_64' as const };
function fake(rows: unknown[]): EnrollmentSqlExecutor { return async () => ({ rows }); }

test('adapter refuses implicit database connection', () => {
  assert.throws(() => createPostgresEnrollmentGateway(undefined as never), TypeError);
});

test('issuance passes only hashes and verified actor to parameterized SQL', async () => {
  const m = createAgentSecretMaterial();
  let captured = '';
  const g = createPostgresEnrollmentGateway(async statement => {
    captured = JSON.stringify(statement);
    return { rows: [{ enrollment_id: ORG }] };
  });
  const id = await g.issue({ subject: identity.subject, organizationId: ORG, label: 'My Server',
    tokenHash: m.tokenHash, tokenPrefix: m.tokenPrefix,
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  assert.equal(id, ORG);
  assert.match(captured, /issue_enrollment/);
  assert.equal(captured.includes(m.oneTimeSecret), false);
});

test('database permission failures are standardized and do not echo secrets', async () => {
  const m = createAgentSecretMaterial();
  const g = createPostgresEnrollmentGateway(async () => { throw { code: '42501', detail: m.oneTimeSecret }; });
  await assert.rejects(g.issue({ subject: identity.subject, organizationId: ORG,
    label: 'Test', tokenHash: m.tokenHash, tokenPrefix: m.tokenPrefix,
    expiresAt: new Date(Date.now() + 600_000).toISOString() }),
  e => e instanceof EnrollmentPermissionDenied && !String(e).includes(m.oneTimeSecret));
});

test('unknown and already consumed enrollment maps to uniform error', async () => {
  const m = createAgentSecretMaterial();
  const c = createAgentSecretMaterial();
  const g = createPostgresEnrollmentGateway(async () => { throw { code: 'P0002' }; });
  await assert.rejects(g.redeem({ enrollmentHash: m.tokenHash, credentialHash: c.tokenHash,
    credentialPrefix: c.tokenPrefix, agent: description }), EnrollmentNotAvailable);
});

test('redemption takes no client-provided organization and verifies result', async () => {
  const m = createAgentSecretMaterial();
  const c = createAgentSecretMaterial();
  const g = createPostgresEnrollmentGateway(fake([{ organization_id: ORG, agent_id: AGENT }]));
  assert.deepEqual(await g.redeem({ enrollmentHash: m.tokenHash, credentialHash: c.tokenHash,
    credentialPrefix: c.tokenPrefix, agent: description }), { organizationId: ORG, agentId: AGENT });
  const invalid = createPostgresEnrollmentGateway(fake([{ organization_id: 'invalid', agent_id: AGENT }]));
  await assert.rejects(invalid.redeem({ enrollmentHash: m.tokenHash, credentialHash: c.tokenHash,
    credentialPrefix: c.tokenPrefix, agent: description }));
});

test('untrusted missing and invalid machine secret does not touch database', async () => {
  let calls = 0;
  const g = createPostgresEnrollmentGateway(async () => { calls++; return { rows: [] }; });
  assert.equal(await g.verifyMachineCredential(''), null);
  assert.equal(await g.verifyMachineCredential('aa'.repeat(32)), null);
  assert.equal(calls, 0);
  assert.equal(await g.verifyMachineCredential(createAgentSecretMaterial().oneTimeSecret), null);
  assert.equal(calls, 1);
});

test('credential verification returns only database-bound tenant and agent', async () => {
  const g = createPostgresEnrollmentGateway(fake([{ organization_id: ORG, agent_id: AGENT }]));
  assert.deepEqual(await g.verifyMachineCredential(createAgentSecretMaterial().oneTimeSecret),
    { organizationId: ORG, agentId: AGENT });
});

test('revocation requires server-side verified actor and strict result', async () => {
  let calls = 0;
  const g = createPostgresEnrollmentGateway(async () => { calls++; return { rows: [{ revoked: true }] }; });
  await assert.rejects(g.revokeAgent({ ...identity, sessionId: '' }, ORG, AGENT), TypeError);
  assert.equal(calls, 0);
  assert.equal(await g.revokeAgent(identity, ORG, AGENT), true);
  assert.equal(calls, 1);
});

test('rotation creates a fresh one-time credential; never client-selected', async () => {
  const g = createPostgresEnrollmentGateway(fake([{ rotated: true }]));
  const a = await g.rotateCredential(identity, ORG, AGENT);
  const b = await g.rotateCredential(identity, ORG, AGENT);
  assert.equal(a.organizationId, ORG);
  assert.equal(a.agentId, AGENT);
  assert.match(a.machineCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.machineCredential, b.machineCredential);
});

test('unexpected result rows fail closed for all actions', async () => {
  const g = createPostgresEnrollmentGateway(fake([{ rotated: false, revoked: 'yes' }]));
  await assert.rejects(g.rotateCredential(identity, ORG, AGENT));
  await assert.rejects(g.revokeAgent(identity, ORG, AGENT));
});
