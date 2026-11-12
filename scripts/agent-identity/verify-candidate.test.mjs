import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyD13Source } from './verify-candidate.mjs';
const SQL='scripts/agent-identity/migrations/0003_preallocated_identity.sql';
const read=()=>readFileSync(join(process.cwd(),SQL));
function tampered(mutator){const text=read().toString('utf8');const altered=mutator(text);
  assert.notEqual(altered,text,'negative case must mutate reviewed SQL');
  assert.throws(()=>verifyD13Source(process.cwd(),{sqlBytes:Buffer.from(altered)}),/REFUSE_D13_SOURCE/);
}
test('D13 reviewed SQL and 18 immutable Git blobs verify',()=>{
  const result=verifyD13Source();
  assert.equal(result.pinned,18);
});
test('D13 rejects a missing COMMIT',()=>tampered(s=>s.replace('COMMIT;','-- COMMIT removed')));
test('D13 rejects missing NOLOGIN executor',()=>tampered(s=>s.replace('NOLOGIN NOINHERIT','LOGIN NOINHERIT')));
test('D13 rejects weaker RLS',()=>tampered(s=>s.replace('FORCE ROW LEVEL SECURITY','DISABLE ROW LEVEL SECURITY')));
test('D13 rejects unbound prior function permissions',()=>tampered(s=>s.replace(
  'REVOKE EXECUTE ON FUNCTION pulse_agent_enrollment.redeem_enrollment',
  'GRANT EXECUTE ON FUNCTION pulse_agent_enrollment.redeem_enrollment')));
test('D13 rejects deleted receipt',()=>tampered(s=>s.replace("VALUES ('0003'", "VALUES ('0004'")));
test('D13 rejects removed tenant FK',()=>tampered(s=>s.replace('d13_bound_agent_tenant FOREIGN KEY','d13_bound_agent_tenant CHECK')));
test('D13 rejects removal of pending-only redemption',()=>tampered(s=>s.replace("v.status<>'pending'",'false')));
test('D13 rejects removed row lock',()=>tampered(s=>s.replace('FOR UPDATE OF t,a','')));
test('D13 refuses unqualified redemption UPDATE tenant filter',()=>tampered(s=>s.replace(
  'AND target.organization_id=v.org AND target.status=\'pending\'',
  'AND organization_id=v.org AND status=\'pending\'')));
test('D13 refuses modifications to pinned D12 HTTPS source',()=>{
  const path='src/agent/enrollment/https-redemption.ts';
  assert.throws(()=>verifyD13Source(process.cwd(),{blobOverrides:{[path]:Buffer.from('tampered')}}),/REFUSE_D13_SOURCE/);
});
test('D13 refuses modifications to pinned PostgreSQL D10 SQL',()=>{
  const path='scripts/agent-ingress/migrations/0002_agent_ingress_quota.sql';
  assert.throws(()=>verifyD13Source(process.cwd(),{blobOverrides:{[path]:Buffer.from('tampered')}}),/REFUSE_D13_SOURCE/);
});
