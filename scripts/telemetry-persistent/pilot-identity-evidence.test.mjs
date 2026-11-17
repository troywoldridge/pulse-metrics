import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_PURPOSE, REVIEWED_LOCAL_TARGET, canonicalJSON, approvalSigningBytes } from './pilot-authorization-policy.mjs';
import { validatePilotIdentityEvidence, parseIdentityEvidence, compareSignedIdentityEvidence,
  IDENTITY_EVIDENCE_SOURCE } from './pilot-identity-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'review-pilot-identity.mjs');
const operator = join(here, 'read-disposable-pilot-identity.sh');
const sql = join(here, 'pilot-identity-evidence.sql');
const org = 'b5ab11cb-8784-4de3-873c-a9fdacfd083c';
const agent = '05cf23e1-92de-4cbb-a3a6-a33ecb6ad772';
const owner = '80723197-9b64-4762-8bdd-08f474788c9a';
const issue = '2026-11-17T10:00:00.000Z';
const expiry = '2026-11-18T09:00:00.000Z';
const now = Date.parse('2026-11-17T11:00:00.000Z');
const kp = generateKeyPairSync('ed25519');
const pem = kp.publicKey.export({ type: 'spki', format: 'pem' });
const fingerprint = createHash('sha256').update(kp.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

const fixture = () => ({
  version:1,
  source: IDENTITY_EVIDENCE_SOURCE,
  target: { database:'pulse_metrics', port:55432,
    transport:'private-unix-socket-no-tcp', dataDirectoryClass:'disposable-pulse-replay' },
  organizations:[{ id:org }],
  users:[{ id:owner }],
  memberships:[{ organizationId:org, userId:owner, role:'owner' }],
  agents:[{ organizationId:org, agentId:agent, status:'active' }],
  credentials:[{ organizationId:org, agentId:agent, revoked:false, scopes:['telemetry:write'] }],
  sampleCount:0, submissionCount:0,
  security:{ rlsViolations:0, unsafeRoles:0, migrationReceiptErrors:0,
    unscopedVisibleSamples:0, runtimeCredentialRead:false, runtimeDirectTelemetryInsert:false },
});
const proposal = () => ({
  version:1, purpose:APPROVAL_PURPOSE, environment:'isolated-local-development',
  target:{...REVIEWED_LOCAL_TARGET}, ownerUserId:owner,
  policy:{ version:1, mode:'bounded', organizationId:org, agentId:agent,
    expectedSamplesMin:1, expectedSamplesMax:100, agentStatus:'active' },
  approval:{ reviewId:'PM-2F2J2026', reviewer:'independent-reviewer',
    independentReview:'required-outside-database' },
  issuedAt:issue, expiresAt:expiry,
});
function signed(proposed = proposal()) {
  return canonicalJSON({ format:'pulse-metrics/2f2i/ed25519-v1',
    manifest:proposed,
    signature:sign(null, approvalSigningBytes(proposed),kp.privateKey).toString('base64url') });
}
function bad(fn) { assert.throws(fn,/REFUSE_D15C5U2F2J|REFUSE_D15C5U2F2I/); }
function env() {
  const e={...process.env};
  for(const k of ['NODE_OPTIONS','NODE_EXTRA_CA_CERTS','DATABASE_URL','MIGRATION_DATABASE_URL',
    'PGHOST','PGPORT','PGUSER','PGDATABASE','PGOPTIONS','PULSE_APPROVE_5U2F2G_EMPTY_EXERCISE']) delete e[k];
  e.NODE_ENV='development';return e;
}
function cliRun(args, input) {return spawnSync(process.execPath,[cli,...args],
  {env:env(),encoding:'utf8',input,timeout:6000});}
function shellRun(args) {return spawnSync('bash',[operator,...args],
  {env:env(),encoding:'utf8',timeout:6000});}
function withFiles(fn) {
  const d=mkdtempSync(join(tmpdir(),'pulse-2f2j-'));
  try{return fn(d);}finally{rmSync(d,{recursive:true,force:true});}
}

test('full 2F2J shell and JavaScript parse',()=>{
  for(const f of ['pilot-identity-evidence.mjs','pilot-identity-evidence.test.mjs','review-pilot-identity.mjs']){
    const p=spawnSync(process.execPath,['--check',join(here,f)],{encoding:'utf8'});
    assert.equal(p.status,0,p.stderr);
  }
  const p=spawnSync('bash',['-n',operator],{encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);
});
test('operator and reviewer plans are read-only and launch-blocked',()=>{
  for(const p of [shellRun(['--plan']),cliRun(['--plan'])]){
    assert.equal(p.status,0,p.stderr);
    assert.match(p.stdout,/NO (POSTGRESQL START|ENROLLMENT)/);
    assert.match(p.stdout,/NO WRITES/);
    assert.match(p.stdout,/NO_GO/);
  }
});
test('exact owner/organization/agent and credential evidence validates',()=>{
  assert.deepEqual(validatePilotIdentityEvidence(fixture()),
    {organizationId:org,ownerUserId:owner,agentId:agent});
});
test('real-shaped PostgreSQL JSONB evidence parses but is not attested',()=>{
  const raw=JSON.stringify(fixture());
  assert.deepEqual(parseIdentityEvidence(` ${raw}\n`).identity,
    {organizationId:org,ownerUserId:owner,agentId:agent});
});
test('valid signed manifest matches pretelemetry identity but NEVER authorizes',()=>{
  assert.deepEqual(compareSignedIdentityEvidence(signed(),pem,fingerprint,fixture(),now),{
    signatureVerified:true,identityContractMatches:true,databaseAttested:false,
    operationalAuthorization:false,reviewOnly:true,
  });
});
test('wrong signer, wrong fingerprint and expired approval all deny',()=>{
  bad(()=>compareSignedIdentityEvidence(signed(),pem,'0'.repeat(64),fixture(),now));
  const wrong=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  bad(()=>compareSignedIdentityEvidence(signed(),wrong,fingerprint,fixture(),now));
  bad(()=>compareSignedIdentityEvidence(signed(),pem,fingerprint,fixture(),Date.parse(expiry)));
});
test('forged owner user ID is refused even with an otherwise valid signed manifest',()=>{
  const e=fixture();e.users[0].id='80723197-9b64-4762-8bdd-08f474788c9b';
  bad(()=>compareSignedIdentityEvidence(signed(),pem,fingerprint,e,now));
});
test('owner membership must bind the exact selected user and organization',()=>{
  for(const change of [
    e=>{e.memberships[0].userId='80723197-9b64-4762-8bdd-08f474788c9b';},
    e=>{e.memberships[0].organizationId='b5ab11cb-8784-4de3-873c-a9fdacfd083d';},
    e=>{e.memberships[0].role='viewer';},
    e=>{e.memberships[0].role='admin';},
    e=>{e.memberships[0].role='member';},
    e=>{e.memberships[0].role='Owner';},
  ]) {const e=fixture();change(e);bad(()=>validatePilotIdentityEvidence(e));}
});
test('agent must match selected tenant, exact agent and active status',()=>{
  for(const change of [
    e=>{e.agents[0].organizationId='b5ab11cb-8784-4de3-873c-a9fdacfd083d';},
    e=>{e.agents[0].agentId='05cf23e1-92de-4cbb-a3a6-a33ecb6ad773';},
    e=>{e.agents[0].status='revoked';},
    e=>{e.agents[0].status='pending';},
    e=>{e.agents[0].status='offline';},
  ]) {const e=fixture();change(e);bad(()=>compareSignedIdentityEvidence(signed(),pem,fingerprint,e,now));}
});
test('credential is exactly one active scoped credential for the same agent',()=>{
  for(const change of [
    e=>{e.credentials[0].organizationId='b5ab11cb-8784-4de3-873c-a9fdacfd083d';},
    e=>{e.credentials[0].agentId='05cf23e1-92de-4cbb-a3a6-a33ecb6ad773';},
    e=>{e.credentials[0].revoked=true;},
    e=>{e.credentials[0].scopes=['telemetry:read'];},
    e=>{e.credentials[0].scopes=['telemetry:write','telemetry:read'];},
  ]) {const e=fixture();change(e);bad(()=>validatePilotIdentityEvidence(e));}
});
test('additional users, organizations, memberships, agents and credentials are all denied',()=>{
  for(const k of ['users','organizations','memberships','agents','credentials']){
    const e=fixture();e[k].push({...e[k][0]});bad(()=>validatePilotIdentityEvidence(e));
  }
});
test('zero-sample identity preflight NEVER weakens nonzero telemetry limits',()=>{
  for(const change of [e=>{e.sampleCount=1;}, e=>{e.submissionCount=1;},
    e=>{e.sampleCount=2;e.submissionCount=2;}]) {
    const e=fixture();change(e);bad(()=>validatePilotIdentityEvidence(e));
  }
  assert.equal(proposal().policy.expectedSamplesMin,1);
});
test('RLS, role permission, visibility and migration regressions fail closed',()=>{
  for(const change of [
    e=>{e.security.rlsViolations=1;},e=>{e.security.unsafeRoles=1;},
    e=>{e.security.migrationReceiptErrors=1;},
    e=>{e.security.unscopedVisibleSamples=1;},
    e=>{e.security.runtimeCredentialRead=true;},
    e=>{e.security.runtimeDirectTelemetryInsert=true;},
  ]) {const e=fixture();change(e);bad(()=>validatePilotIdentityEvidence(e));}
});
test('unexpected evidence keys, invalid types and forged source are denied',()=>{
  for(const change of [
    e=>{e.extra=1;},e=>{e.security.extra=1;},e=>{e.users[0].authSubject='private';},
    e=>{e.target.database='postgres';},e=>{e.target.port=55433;},
    e=>{e.source='protected-55433';}, e=>{e.version=2;},
    e=>{e.security.rlsViolations='0';},e=>{e.credentials[0].revoked='false';},
  ]) {const e=fixture();change(e);bad(()=>validatePilotIdentityEvidence(e));}
});
test('parser refuses malformed, multiline, oversized and empty output',()=>{
  for(const raw of ['','{}','[]','not-json',JSON.stringify(fixture())+'\n{}',
    JSON.stringify(fixture()).replace(',',',\n'), 'x'.repeat(17000)]){
    bad(()=>parseIdentityEvidence(raw));
  }
});
test('offline CLI accepts only bounded evidence files, never authorizes a database',()=>{
  withFiles(d=>{
    const e=join(d,'evidence.json');writeFileSync(e,JSON.stringify(fixture()),{mode:0o600});
    const p=cliRun(['--check-offline-evidence',e]);
    assert.equal(p.status,0,p.stderr);
    assert.match(p.stdout,/DATABASE NOT ATTESTED/);
    assert.doesNotMatch(p.stdout,new RegExp(agent));
    assert.doesNotMatch(p.stdout,new RegExp(owner));
  });
});
test('signed offline CLI compares independently pinned public key and exact evidence',()=>{
  withFiles(d=>{
    const e=join(d,'evidence.json'), m=join(d,'manifest.json'), k=join(d,'key.pem');
    writeFileSync(e,JSON.stringify(fixture()),{mode:0o600});
    writeFileSync(m,signed(),{mode:0o600});
    writeFileSync(k,pem,{mode:0o600});
    // CLI uses current wall clock; this synthetic 2026-11-17 approval may expire
    // when installed. Test CLI rejection instead of claiming indefinite validity.
    const badKey=cliRun(['--compare-signed-offline',m,k,'0'.repeat(64),e]);
    assert.notEqual(badKey.status,0);
    assert.match(badKey.stderr,/REFUSE_D15C5U2F2J/);
  });
});
test('operator never runs for arbitrary hosts, protected 55433 or missing args',()=>{
  for(const args of [[],['--write'],['--start'],['--plan','extra'],
    ['--audit-existing-disposable','/var/lib/postgresql/pulse-metrics-dev-5u2/socket'],
    ['--audit-existing-disposable','/tmp'],['--audit-existing-disposable','localhost'],
    ['--audit-existing-disposable','/tmp/pulse-replay-1234567890/socket','extra']]){
    const p=shellRun(args);assert.notEqual(p.status,0,`${args}: ${p.stdout}`);
    assert.match(p.stderr,/REFUSE_D15C5U2F2J/);
  }
});
test('offline reviewer refuses relative and symlink files',()=>{
  assert.notEqual(cliRun([]).status,0);
  assert.notEqual(cliRun(['--check-offline-evidence','relative.json']).status,0);
  withFiles(d=>{
    const p=join(d,'evidence.json'), link=join(d,'link.json');
    writeFileSync(p,JSON.stringify(fixture()),{mode:0o600});symlinkSync(p,link);
    const q=cliRun(['--check-offline-evidence',link]);assert.notEqual(q.status,0);
  });
});
test('read-only SQL hard-pins disposable PostgreSQL, no protected target or DDL',()=>{
  const s=readFileSync(sql,'utf8');
  assert.match(s,/55432/);
  assert.match(s,/pulse-replay-\[A-Za-z0-9\]/);
  assert.match(s,/REPEATABLE READ READ ONLY/);
  assert.match(s,/current_setting\('listen_addresses'\)/);
  assert.match(s,/SET LOCAL ROLE pulse_metrics_app/);
  assert.match(s,/public\.organization_memberships/);
  assert.match(s,/m\.user_id::text/);
  assert.match(s,/m\.role::text/);
  assert.match(s,/c\.revoked_at IS NOT NULL/);
  const withoutComments=s.split('\n').filter(x=>!/^\s*--/.test(x)).join('\n');
  assert.doesNotMatch(withoutComments,/55433/);
  assert.doesNotMatch(withoutComments,/\b(?:INSERT INTO|UPDATE\s+|DELETE FROM|TRUNCATE|CREATE ROLE|ALTER ROLE|DROP TABLE|COPY\s+.*\s+TO)\b/i);
});
test('disposable operator uses pinned stdin SQL, not postgres filesystem access',()=>{
  const s=readFileSync(operator,'utf8');
  assert.match(s,/exec 9< "\$SQL"/);
  assert.match(s,/psql -X --no-password/);
  assert.match(s,/-f - <&9/);
  assert.match(s,/sha256sum -c --status/);
  assert.doesNotMatch(s,/psql[^\n]*-f "\$SQL"/);
  assert.doesNotMatch(s,/\bpg_ctl\b|\binitdb\b|\bCREATE DATABASE\b/);
});
test('read-only candidate is explicitly not a protected-cluster live audit',()=>{
  const s=readFileSync(operator,'utf8');
  assert.match(s,/DOES NOT TARGET PROTECTED 55433/);
  assert.match(s,/NO AUTHORIZATION/);
  const p=shellRun(['--audit-existing-disposable','/tmp/pulse-replay-1234567890/socket']);
  assert.notEqual(p.status,0);
});
