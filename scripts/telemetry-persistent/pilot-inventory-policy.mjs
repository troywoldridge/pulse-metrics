// Pulse Metrics D15C-5U-2F2G — bounded development-pilot inventory contract.
// Pure policy only: does not query PostgreSQL, authorize writes, enroll agents,
// generate credentials, or infer authorized identities from database contents.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function refuse(reason) { throw new Error(`REFUSE_D15C5U2F2G_POLICY: ${reason}`); }
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function keys(value, expected, label) {
  if (!record(value) || Object.keys(value).length !== expected.length ||
      expected.some(key => !Object.hasOwn(value, key))) {
    refuse(`${label}: unexpected shape`);
  }
}
function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) refuse(`${label}: invalid UUID`);
}
function count(value, label, limit = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
    refuse(`${label}: invalid count`);
  }
}
function exactArray(value, label, max = 1000) {
  if (!Array.isArray(value) || value.length > max) refuse(`${label}: invalid collection`);
}
function noDuplicates(items, key, label) {
  if (new Set(items.map(key)).size !== items.length) refuse(`${label}: duplicates`);
}
function verifyPolicy(policy) {
  if (!record(policy) || policy.version !== 1) refuse('unsupported policy');
  if (policy.mode === 'empty') {
    keys(policy, ['version', 'mode'], 'empty policy');
    return policy;
  }
  if (policy.mode !== 'bounded') refuse('unsupported mode');
  keys(policy, ['version', 'mode', 'organizationId', 'agentId',
    'expectedSamplesMin', 'expectedSamplesMax', 'agentStatus'], 'bounded policy');
  uuid(policy.organizationId, 'organizationId');
  uuid(policy.agentId, 'agentId');
  count(policy.expectedSamplesMin, 'expectedSamplesMin', 1000);
  count(policy.expectedSamplesMax, 'expectedSamplesMax', 1000);
  if (policy.expectedSamplesMin < 1 ||
      policy.expectedSamplesMin > policy.expectedSamplesMax) refuse('invalid bounded sample window');
  if (!['active', 'revoked'].includes(policy.agentStatus)) refuse('invalid agent status');
  return policy;
}

/**
 * Validate a _trusted, independently queried_ inventory. The snapshot must be
 * obtained using a previously reviewed read-only PostgreSQL adapter. Neither
 * this function nor an untrusted caller may grant authorization from a snapshot.
 * The bounded policy MUST be preapproved outside the database being audited.
 */
export function assessPilotInventory(snapshot, untrustedPolicy) {
  const policy = verifyPolicy(untrustedPolicy);
  keys(snapshot, ['version', 'organizationIds', 'userCount', 'membershipCount',
    'agents', 'credentials', 'sampleCount', 'submissionCount', 'samplesByAgent',
    'orphanSamples', 'mismatchedLedger', 'unownedTelemetry', 'unscopedVisibleSamples',
    'rlsViolations', 'unsafeRoles', 'migrationReceiptErrors', 'runtimeCredentialRead',
    'runtimeDirectTelemetryInsert'], 'inventory');
  if (snapshot.version !== 1) refuse('inventory schema mismatch');
  exactArray(snapshot.organizationIds, 'organizationIds', 1);
  exactArray(snapshot.agents, 'agents', 1);
  exactArray(snapshot.credentials, 'credentials', 1);
  exactArray(snapshot.samplesByAgent, 'samplesByAgent', 1);
  snapshot.organizationIds.forEach(id => uuid(id, 'inventory organization'));
  noDuplicates(snapshot.organizationIds, id => id, 'organizations');
  for (const [i, a] of snapshot.agents.entries()) {
    keys(a, ['organizationId', 'agentId', 'status'], `agent ${i}`);
    uuid(a.organizationId, 'agent organization');
    uuid(a.agentId, 'agent ID');
    if (!['pending', 'active', 'offline', 'revoked'].includes(a.status)) refuse('invalid agent state');
  }
  noDuplicates(snapshot.agents, a => a.agentId, 'agents');
  for (const [i, c] of snapshot.credentials.entries()) {
    keys(c, ['organizationId', 'agentId', 'revoked', 'scopes'], `credential ${i}`);
    uuid(c.organizationId, 'credential organization');
    uuid(c.agentId, 'credential agent');
    if (typeof c.revoked !== 'boolean' || !Array.isArray(c.scopes) ||
        c.scopes.length !== 1 || c.scopes[0] !== 'telemetry:write') {
      refuse('credential state or scopes invalid');
    }
  }
  noDuplicates(snapshot.credentials, c => c.organizationId + '/' + c.agentId, 'credentials');
  for (const [i, row] of snapshot.samplesByAgent.entries()) {
    keys(row, ['organizationId', 'agentId', 'count'], `sample group ${i}`);
    uuid(row.organizationId, 'sample organization');
    uuid(row.agentId, 'sample agent');
    count(row.count, 'agent samples');
  }
  noDuplicates(snapshot.samplesByAgent, r => r.organizationId + '/' + r.agentId, 'sample groups');
  for (const k of ['userCount', 'membershipCount', 'sampleCount', 'submissionCount',
    'orphanSamples', 'mismatchedLedger', 'unownedTelemetry', 'unscopedVisibleSamples',
    'rlsViolations', 'unsafeRoles', 'migrationReceiptErrors']) count(snapshot[k], k);
  if (typeof snapshot.runtimeCredentialRead !== 'boolean' ||
      typeof snapshot.runtimeDirectTelemetryInsert !== 'boolean') refuse('invalid permission flags');
  if (snapshot.orphanSamples !== 0 || snapshot.mismatchedLedger !== 0 ||
      snapshot.unownedTelemetry !== 0 || snapshot.unscopedVisibleSamples !== 0 ||
      snapshot.rlsViolations !== 0 || snapshot.unsafeRoles !== 0 ||
      snapshot.migrationReceiptErrors !== 0 || snapshot.runtimeCredentialRead ||
      snapshot.runtimeDirectTelemetryInsert) refuse('security invariant violated');
  if (snapshot.sampleCount !== snapshot.submissionCount ||
      snapshot.samplesByAgent.reduce((n, x) => n + x.count, 0) !== snapshot.sampleCount) {
    refuse('ledger/accounting mismatch');
  }
  if (policy.mode === 'empty') {
    if (snapshot.organizationIds.length || snapshot.userCount || snapshot.membershipCount ||
        snapshot.agents.length || snapshot.credentials.length ||
        snapshot.sampleCount || snapshot.samplesByAgent.length) {
      refuse('empty pilot unexpectedly contains operational data');
    }
    return Object.freeze({ mode: 'empty', sampleCount: 0, agentCount: 0 });
  }
  const same = x => x.organizationId === policy.organizationId && x.agentId === policy.agentId;
  if (snapshot.organizationIds.length !== 1 || snapshot.organizationIds[0] !== policy.organizationId ||
      snapshot.userCount !== 1 || snapshot.membershipCount !== 1 ||
      snapshot.agents.length !== 1 || !same(snapshot.agents[0]) ||
      snapshot.agents[0].status !== policy.agentStatus ||
      snapshot.credentials.length !== 1 || !same(snapshot.credentials[0]) ||
      snapshot.credentials[0].revoked !== (policy.agentStatus === 'revoked') ||
      snapshot.samplesByAgent.length !== 1 || !same(snapshot.samplesByAgent[0]) ||
      snapshot.sampleCount < policy.expectedSamplesMin ||
      snapshot.sampleCount > policy.expectedSamplesMax) refuse('outside explicitly approved pilot scope');
  return Object.freeze({ mode: 'bounded', sampleCount: snapshot.sampleCount, agentCount: 1 });
}

export { verifyPolicy as validatePilotPolicy };
