import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPECTED_SQL_SHA256, sourceAudit } from './verify-candidate.mjs';
import { createHash } from 'node:crypto';

const original = readFileSync(resolve('scripts/agent-enrollment/migrations/0001_agent_enrollment.sql'), 'utf8');

test('migration SHA256 independent reviewed source lock', () => {
  assert.equal(createHash('sha256').update(original).digest('hex'), EXPECTED_SQL_SHA256);
});
test('candidate must include fixed transaction, revocation, tenant policy and receipts', () => {
  assert.equal(sourceAudit(original).ok, true);
});
test('dropping transaction commit is detected', () => {
  assert.equal(sourceAudit(original.replace('COMMIT;', '')).ok, false);
});
test('dropping NOLOGIN executor is detected', () => {
  assert.equal(sourceAudit(original.replace('NOLOGIN NOINHERIT', 'LOGIN INHERIT')).ok, false);
});
test('dropping hardened function search path is detected', () => {
  assert.equal(sourceAudit(original.replaceAll('SECURITY DEFINER SET search_path=pg_catalog,pg_temp','SECURITY DEFINER')).ok, false);
});
test('dropping schema PUBLIC denial is detected', () => {
  assert.equal(sourceAudit(original.replace('REVOKE ALL ON SCHEMA pulse_agent_enrollment FROM PUBLIC','-- omitted')).ok, false);
});
test('adding broad function grant is refused', () => {
  assert.equal(sourceAudit(original + '\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pulse_agent_enrollment TO PUBLIC;').ok, false);
});
test('deleting migration-version receipt is detected', () => {
  assert.equal(sourceAudit(original.replaceAll('pulse_agent_enrollment.schema_migrations','other_schema.table')).ok, false);
});
test('deleting credential revocation is detected', () => {
  assert.equal(sourceAudit(original.replaceAll('pulse_agent_enrollment.revoke_agent','disabled_revoke')).ok, false);
});
