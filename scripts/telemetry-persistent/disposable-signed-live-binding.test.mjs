import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySyntheticEvidenceFromStdin, rehearseSyntheticSignedLiveIdentity } from './disposable-signed-live-binding.mjs';
import { IDENTITY_EVIDENCE_SOURCE } from './pilot-identity-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bind = join(here, 'disposable-signed-live-binding.mjs');
const stage = join(here, 'disposable-signed-live-binding-stage.sh');
const runner = join(here, 'run-disposable-signed-live-binding.sh');
const sql = join(here, 'pilot-identity-evidence.sql');
const org='b5ab11cb-8784-4de3-873c-a9fdacfd083c';
const user='80723197-9b64-4762-8bdd-08f474788c9a';
const agent='05cf23e1-92de-4cbb-a3a6-a33ecb6ad772';
const clock=Date.parse('2026-11-17T16:00:00.000Z');
const makeEvidence=()=>({
  version:1,source:IDENTITY_EVIDENCE_SOURCE,
  target:{database:'pulse_metrics',port:55432,transport:'private-unix-socket-no-tcp',
    dataDirectoryClass:'disposable-pulse-replay'},
  organizations:[{id:org}],users:[{id:user}],
  memberships:[{organizationId:org,userId:user,role:'owner'}],
  agents:[{organizationId:org,agentId:agent,status:'active'}],
  credentials:[{organizationId:org,agentId:agent,revoked:false,scopes:['telemetry:write']}],
  sampleCount:0,submissionCount:0,
  security:{rlsViolations:0,unsafeRoles:0,migrationReceiptErrors:0,
    unscopedVisibleSamples:0,runtimeCredentialRead:false,runtimeDirectTelemetryInsert:false},
});
function runNode(args=[], input=''){
  const env={...process.env};
  for(const key of ['NODE_OPTIONS','NODE_EXTRA_CA_CERTS','DATABASE_URL','MIGRATION_DATABASE_URL']) delete env[key];
  return spawnSync(process.execPath,[bind,...args],{env,input,encoding:'utf8',timeout:15000});
}
function mutate(fn){const e=makeEvidence();fn(e);assert.throws(()=>rehearseSyntheticSignedLiveIdentity(e,clock),/REFUSE_D15C5U2F2J/);}

test('2F2L complete new JavaScript and Bash files parse',()=>{
  for(const p of [bind,join(here,'disposable-signed-live-binding.test.mjs')]){
    const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  }
  for(const p of [stage,runner]){
    const r=spawnSync('bash',['-n',p],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  }
});
test('valid EXACT synthetic identity is signed with ephemeral Ed25519 and never authorized',()=>{
  const x=rehearseSyntheticSignedLiveIdentity(makeEvidence(),clock);
  assert.deepEqual(x,{
    syntheticSignatureMatches:true,syntheticNegativeChecks:9,
    selfPinnedTestOnlyKey:true,externallyApprovedSigner:false,
    databaseAttestedBySignature:false,operationalAuthorization:false,
    persistentTelemetryWritesAuthorized:false,
  });
});
test('independent ephemeral key generation works for repeated isolated synthetic trials',()=>{
  assert.equal(rehearseSyntheticSignedLiveIdentity(makeEvidence(),clock).syntheticNegativeChecks,9);
  assert.equal(rehearseSyntheticSignedLiveIdentity(makeEvidence(),clock+1000).syntheticSignatureMatches,true);
});
test('strict streamed JSON evidence must contain exactly one valid object',()=>{
  assert.equal(verifySyntheticEvidenceFromStdin(JSON.stringify(makeEvidence())+'\n',clock).operationalAuthorization,false);
  for(const x of ['','[]','{}','garbage','{}\n{}','x'.repeat(20000)]) {
    assert.throws(()=>verifySyntheticEvidenceFromStdin(x,clock));
  }
});
test('owner and membership tampering is denied before signing',()=>{
  mutate(e=>{e.users[0].id='88888888-8888-4888-8888-888888888888'});
  mutate(e=>{e.memberships[0].role='viewer'});
  mutate(e=>{e.memberships[0].organizationId='99999999-9999-4999-8999-999999999999'});
});
test('foreign/revoked agent is denied before signing',()=>{
  mutate(e=>{e.agents[0].organizationId='99999999-9999-4999-8999-999999999999'});
  mutate(e=>{e.agents[0].status='revoked'});
  mutate(e=>{e.agents.push({...e.agents[0]})});
});
test('wrong credential, revoked credential and extra scopes are denied',()=>{
  mutate(e=>{e.credentials[0].revoked=true});
  mutate(e=>{e.credentials[0].agentId='99999999-9999-4999-8999-999999999999'});
  mutate(e=>{e.credentials[0].scopes=['telemetry:read','telemetry:write']});
});
test('no pre-telemetry sample and no extra users/organizations permitted',()=>{
  mutate(e=>{e.sampleCount=1});
  mutate(e=>{e.submissionCount=1});
  mutate(e=>{e.users.push({...e.users[0]})});
  mutate(e=>{e.organizations.push({...e.organizations[0]})});
});
test('unscoped RLS and direct credentials/telemetry grants must stay denied',()=>{
  mutate(e=>{e.security.rlsViolations=1});
  mutate(e=>{e.security.unsafeRoles=1});
  mutate(e=>{e.security.runtimeCredentialRead=true});
  mutate(e=>{e.security.runtimeDirectTelemetryInsert=true});
});
test('invalid clocks are refused before key generation',()=>{
  for(const now of [-1,NaN,Infinity,1.5,8640000000000000]){
    assert.throws(()=>rehearseSyntheticSignedLiveIdentity(makeEvidence(),now),/REFUSE_D15C5U2F2L/);
  }
});
test('CLI plan is explicitly never approval or a PostgreSQL operation',()=>{
  const x=runNode(['--plan']);
  assert.equal(x.status,0,x.stderr);
  assert.match(x.stdout,/SELF-PINNED|SELF-PINNED|self-pinned/i);
  assert.match(x.stdout,/NO POSTGRESQL START/);
  assert.match(x.stdout,/NO WRITES/);
  assert.match(x.stdout,/NO_GO/);
});
test('CLI fails closed on missing, unknown, or combined flags',()=>{
  for(const args of [[],['--write'],['--enroll'],['--plan','--synthetic-disposable-stdin'],['--synthetic-disposable-stdin','--plan']]){
    const x=runNode(args);
    assert.notEqual(x.status,0);
    assert.match(x.stderr,/REFUSE_D15C5U2F2L/);
  }
});
test('CLI streamed test success prints no identifiers, signature or key material',()=>{
  const x=runNode(['--synthetic-disposable-stdin'],JSON.stringify(makeEvidence())+'\n');
  assert.equal(x.status,0,x.stderr);
  assert.match(x.stdout,/test-only signed manifest/);
  assert.match(x.stdout,/NO AUTHORIZATION/);
  assert.doesNotMatch(x.stdout,new RegExp(`${user}|${org}|${agent}|PRIVATE KEY|BEGIN PUBLIC KEY`));
});
test('malformed CLI stream is denied without diagnostics or fake PASS',()=>{
  const x=runNode(['--synthetic-disposable-stdin'],'{"user":"forged"}');
  assert.notEqual(x.status,0);
  assert.match(x.stderr,/REFUSE_D15C5U2F2L/);
  assert.doesNotMatch(x.stdout,/PASS:/);
  assert.doesNotMatch(x.stderr,/forged/);
});
test('live stage streams only SHA-pinned read-only 2F2J SQL via FD to Node',()=>{
  const s=readFileSync(stage,'utf8');
  const q=readFileSync(sql,'utf8');
  assert.match(s,/exec 9< "\$SQL_2F2L"/);
  assert.match(s,/sha256sum \/proc\/self\/fd\/9/);
  assert.match(s,/\-f - <&9 \|/);
  assert.match(s,/node "\$BINDER_2F2L" --synthetic-disposable-stdin/);
  assert.match(s,/55432/);
  assert.match(s,/\.pulse-telemetry-quota-marker/);
  assert.match(q,/REPEATABLE READ READ ONLY/);
  assert.match(q,/SET LOCAL ROLE pulse_metrics_app/);
  assert.doesNotMatch(s,/psql[^\n]*-f "\$SQL_2F2L"/);
  assert.doesNotMatch(s,/\b(?:pg_ctl|initdb|CREATE DATABASE|DROP DATABASE)\b/);
});
test('new runner preserves original 2F2K and 4B cleanup, and demands three PASS markers',()=>{
  const s=readFileSync(runner,'utf8');
  assert.match(s,/REVIEWED_REF='78e6640'/);
  assert.match(s,/K_SHA='2132c01589e8471e3ef267e352f93ee3c3a5a46bb9759a91cf399c41b22d2efe'/);
  assert.match(s,/trap cleanup EXIT/);
  assert.match(s,/PASS: disposable quota PostgreSQL cluster removed/);
  assert.match(s,/ONE-TENANT LIVE SQL REHEARSAL: PASS/);
  assert.match(s,/LIVE SQL \+ TEST-ONLY SIGNATURE BINDING: PASS/);
  assert.match(s,/cmp -s "\$ORIGINAL"/);
  assert.match(s,/\bexit 0/);
  assert.match(s,/PULSE_APPROVE_2F2L_DISPOSABLE/);
  assert.doesNotMatch(s,/\brm -rf\b|\bDROP DATABASE\b/);
});
test('wrapper plan never starts PostgreSQL or requires sudo',()=>{
  const x=spawnSync('bash',[runner,'--plan'],{encoding:'utf8',timeout:5000});
  assert.equal(x.status,0,x.stderr);
  assert.match(x.stdout,/No original scripts|No original scripts|No original/i);
  assert.match(x.stdout,/NO REAL SIGNER/);
  assert.match(x.stdout,/NO CUSTOMER ENROLLMENT/);
});
test('runner refuses all unknown modes before reaching PostgreSQL',()=>{
  for(const args of [[],['--exercise-disposable','--verify'],['--write'],['--verify','--exercise-disposable']]){
    const x=spawnSync('bash',[runner,...args],{encoding:'utf8',timeout:5000});
    assert.notEqual(x.status,0);
    assert.match(x.stderr,/REFUSE_D15C5U2F2L/);
  }
});
