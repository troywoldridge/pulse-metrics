import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessPilotInventory, validatePilotPolicy } from './pilot-inventory-policy.mjs';

const d = dirname(fileURLToPath(import.meta.url));
const sh = join(d, 'guarded-persistent-pilot.sh');
const src = readFileSync(sh, 'utf8');
const org = 'b5ab11cb-8784-4de3-873c-a9fdacfd083c';
const agent = '05cf23e1-92de-4cbb-a3a6-a33ecb6ad772';
const emptyPolicy = { version: 1, mode: 'empty' };
const bounded = { version: 1, mode: 'bounded', organizationId: org, agentId: agent,
  expectedSamplesMin: 1, expectedSamplesMax: 10, agentStatus: 'active' };
const base = () => ({
  version: 1, organizationIds: [], userCount: 0, membershipCount: 0,
  agents: [], credentials: [], sampleCount: 0, submissionCount: 0,
  samplesByAgent: [], orphanSamples: 0, mismatchedLedger: 0, unownedTelemetry: 0,
  unscopedVisibleSamples: 0, rlsViolations: 0, unsafeRoles: 0,
  migrationReceiptErrors: 0, runtimeCredentialRead: false,
  runtimeDirectTelemetryInsert: false,
});
const populated = () => ({
  ...base(), organizationIds: [org], userCount: 1, membershipCount: 1,
  agents: [{ organizationId: org, agentId: agent, status: 'active' }],
  credentials: [{ organizationId: org, agentId: agent, revoked: false,
    scopes: ['telemetry:write'] }],
  sampleCount: 3, submissionCount: 3,
  samplesByAgent: [{ organizationId: org, agentId: agent, count: 3 }],
});
function reject(snapshot, policy=bounded) {
  assert.throws(() => assessPilotInventory(snapshot, policy), /REFUSE_D15C5U2F2G_POLICY/);
}
function run(args=[], more={}) {
  return spawnSync('bash', [sh,...args], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '',
      NODE_EXTRA_CA_CERTS: '', DATABASE_URL: '', MIGRATION_DATABASE_URL: '',
      // Never inherit the parent operator's permission to run a live exercise.
      // The refusal probes must test the absence of approval explicitly.
      PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE: '',
      ...more } });
}
test('2F2G shell and policy sources parse in full', () => {
  for (const [prog,args] of [['bash',['-n',sh]],['node',['--check',join(d,'pilot-inventory-policy.mjs')]]]) {
    const p=spawnSync(prog,args,{encoding:'utf8'});
    assert.equal(p.status,0,p.stderr);
  }
});
test('2F2G plan is readable without sudo or a database', () => {
  const p=run(['--plan']);
  assert.equal(p.status,0,p.stderr);
  assert.match(p.stdout,/NO POSTGRESQL STARTED BY PLAN/);
  assert.match(p.stdout,/PERSISTENT TELEMETRY WRITES: NOT APPROVED/);
});
test('2F2G CLI refuses missing, unknown, and multiple modes before operations', () => {
  for(const x of [[],['--start'],['--audit-nonzero'],['--exercise-empty','--verify'],['--write']]) {
    const p=run(x); assert.notEqual(p.status,0); assert.match(p.stderr,/REFUSE_D15C5U2F2G/);
  }
});
test('2F2G fails closed on production, env redirect, service activation and TLS bypass', () => {
  for(const bad of [{NODE_ENV:'production'}, {NODE_OPTIONS:'--inspect'},
    {DATABASE_URL:'postgres://localhost/example'}, {MIGRATION_DATABASE_URL:'postgres://localhost/db'},
    {PGHOST:'/tmp/elsewhere'}, {PGSERVICE:'external'},
    {NODE_TLS_REJECT_UNAUTHORIZED:'0'}, {PULSE_ENABLE_PUBLIC_INGRESS:'YES'},
    {PULSE_D15C5U_LOCAL_ONLY:'YES'}]) {
    const p=run(['--verify'],bad);assert.notEqual(p.status,0);
    assert.match(p.stderr,/REFUSE_D15C5U2F2G/);
  }
});
test('2F2G live empty exercise demands a separate exact approval', () => {
  const p=run(['--exercise-empty']);assert.notEqual(p.status,0);
  assert.match(p.stderr,/REFUSE_D15C5U2F2G/);
  assert.match(src,/PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE/);
  // An invalid approval must fail without attempting PostgreSQL either.
  const invalid=run(['--exercise-empty'],
    { PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE: 'INCORRECT' });
  assert.notEqual(invalid.status,0);
  assert.match(invalid.stderr,/REFUSE_D15C5U2F2G/);
});
test('2F2G self-tests explicitly drop inherited live authorization', () => {
  assert.match(src, /env -u PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE\s*\\?\s*node --test/);
  const p=run(['--exercise-empty'],
    { PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE: '', NODE_ENV:'development' });
  assert.notEqual(p.status,0);
  assert.match(p.stderr,/Independent exact START_AUDIT_STOP_NO_WRITES approval required/);
});
test('2F2G pins old operator, audited preflight, retained backup and read-only nonzero SQL', () => {
  for (const term of ['prepare-local-persistent-pilot.sh',
    'local-development-postgres.sh', 'retained-local-cold-snapshot.sh',
    'nonzero-pilot-ledger.sql', 'sha256sum', '2F2G',
    'START_AUDIT_STOP_ZERO_ROWS', 'PULSE_APPROVE_5U2F2D_READ_ONLY_AUDIT']) assert.ok(src.includes(term),term);
});
test('2F2G live exercise retains mandatory stopped-state and backup verification', () => {
  for(const term of ['--verify', '--audit', 'trap cleanup EXIT',
    'pg_ctl', '--stop', 'inspect-incomplete-persistent-development.sh',
    'PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE']) assert.ok(src.includes(term),term);
  assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE public\.|DELETE FROM|CREATE ROLE|CREATE TABLE)\b/);
});
test('2F2G empty policy recognizes only genuinely empty audited inventory', () => {
  assert.deepEqual(assessPilotInventory(base(),emptyPolicy), {mode:'empty',sampleCount:0,agentCount:0});
  reject(populated(),emptyPolicy);
  const tampered=base();tampered.userCount=1;reject(tampered,emptyPolicy);
});
test('2F2G policy can validate an independently approved one-agent bounded inventory', () => {
  assert.deepEqual(assessPilotInventory(populated(),bounded),
    {mode:'bounded',sampleCount:3,agentCount:1});
});
test('2F2G invalid pilot authorizations are rejected', () => {
  const bad=[{}, {version:1,mode:'write'}, {...bounded,unexpected:true},
    {...bounded,agentId:'no'}, {...bounded,expectedSamplesMax:1001},
    {...bounded,expectedSamplesMin:0}, {...bounded,expectedSamplesMax:0},
    {...bounded,agentStatus:'pending'}, {...bounded,mode:'empty'},
    {...bounded,organizationId:'00000000-0000-0000-0000-000000000000'}];
  for(const item of bad) assert.throws(()=>validatePilotPolicy(item), /REFUSE_D15C5U2F2G_POLICY/);
});
test('2F2G no extra agents, organizations, users, credentials or samples are admitted', () => {
  const extraOrg=populated();extraOrg.organizationIds.push('b5ab11cb-8784-4de3-873c-a9fdacfd083d');reject(extraOrg);
  const extraAgent=populated();extraAgent.agents.push({...extraAgent.agents[0],agentId:'05cf23e1-92de-4cbb-a3a6-a33ecb6ad773'});reject(extraAgent);
  const extraUser=populated();extraUser.userCount=2;reject(extraUser);
  const extraCred=populated();extraCred.credentials.push({...extraCred.credentials[0]});reject(extraCred);
  const tooMany=populated();tooMany.sampleCount=11;tooMany.submissionCount=11;tooMany.samplesByAgent[0].count=11;reject(tooMany);
});
test('2F2G submission accounting rejects mismatched, orphaned or foreign telemetry', () => {
  for (const field of ['orphanSamples','mismatchedLedger','unownedTelemetry']) {
    const s=populated();s[field]=1;reject(s);
  }
  const x=populated();x.submissionCount=2;reject(x);
  const y=populated();y.samplesByAgent[0].count=2;reject(y);
  const z=populated();z.samplesByAgent[0].agentId='05cf23e1-92de-4cbb-a3a6-a33ecb6ad773';reject(z);
});
test('2F2G rejects unscoped sample access, RLS, permissions, roles and receipt regressions',()=>{
  for(const key of ['unscopedVisibleSamples','rlsViolations','unsafeRoles','migrationReceiptErrors']) {
    const s=populated();s[key]=1;reject(s);
  }
  for(const key of ['runtimeCredentialRead','runtimeDirectTelemetryInsert']) {
    const s=populated();s[key]=true;reject(s);
  }
});
test('2F2G rejects revocation drift, credential scope tampering and missing tenant ownership',()=>{
  const s=populated();s.agents[0].status='revoked';reject(s);
  const t=populated();t.credentials[0].scopes=['telemetry:read'];reject(t);
  const u=populated();u.credentials[0].revoked=true;reject(u);
  const v=populated();v.credentials[0].organizationId='b5ab11cb-8784-4de3-873c-a9fdacfd083d';reject(v);
  const r=populated();r.agents[0].status='revoked';r.credentials[0].revoked=true;
  assert.equal(assessPilotInventory(r,{...bounded,agentStatus:'revoked'}).mode,'bounded');
});
test('2F2G rejects unknown inventory keys and invalid numeric or collection shapes',()=>{
  const x=populated();x.accessToken='secret';reject(x);
  const y=populated();y.sampleCount=NaN;reject(y);
  const z=populated();z.sampleCount=-1;reject(z);
  const a=populated();a.organizationIds=['bad'];reject(a);
  const b=populated();b.agents[0].extra='unsafe';reject(b);
  const c=populated();c.credentials[0].scopes=['telemetry:write','other'];reject(c);
});
