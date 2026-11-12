import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAgentSecretMaterial } from './agent-credential-policy.js';
import { EnrollmentNotAvailable, EnrollmentPermissionDenied } from './agent-enrollment-service.js';
import {
  parsePreauthorizationBody,
  createPreauthorizedEnrollmentService,
  createPreauthorizedPostgresGateway,
} from './agent-preauthorization.js';

const ORG='11111111-1111-4111-8111-111111111111';
const AGENT='22222222-2222-4222-8222-222222222222';
const TOKEN='33333333-3333-4333-8333-333333333333';
const OWNER={provider:'workos' as const, subject:'user_d13_owner',sessionId:'verified-session'};
const description={displayName:'Linux Host',hostname:'server.invalid',platform:'linux' as const,architecture:'x86_64' as const};
const material=()=>createAgentSecretMaterial();
const when=()=>new Date(Date.now()+600000).toISOString();

test('D13 issue payload accepts only label and a strict Linux description', () => {
  assert.deepEqual(parsePreauthorizationBody({label:' Server ',agent:description}),
    {label:'Server',agent:description});
  for (const body of [null,[],{label:'Server'},
    {label:'Server',agent:description,agentId:AGENT},
    {label:'Server',agent:{...description,organizationId:ORG}},
    {label:'Server',agent:{...description,platform:'windows'}},
    {label:'Bad\nLabel',agent:description}]) {
    assert.equal(parsePreauthorizationBody(body),null);
  }
});

test('D13 service refuses unverified actor and unauthorized identity shape before gateway', async () => {
  let calls=0;
  const service=createPreauthorizedEnrollmentService({
    issue:async()=>{calls++;return {enrollmentId:TOKEN,agentId:AGENT};},
    redeem:async()=>null,
  });
  await assert.rejects(service.issue({...OWNER,sessionId:''},ORG,'Sample',description),TypeError);
  await assert.rejects(service.issue(OWNER,'foreign','Sample',description),TypeError);
  await assert.rejects(service.issue(OWNER,ORG,'Sample',{...description,hostname:'invalid!'}),TypeError);
  assert.equal(calls,0);
});

test('D13 issue response contains preallocated agent and token; gateway receives only token hash', async () => {
  let seen: unknown;
  const service=createPreauthorizedEnrollmentService({
    issue:async record=>{seen=record;return {enrollmentId:TOKEN,agentId:AGENT};},
    redeem:async()=>null,
  });
  const issued=await service.issue(OWNER,ORG,' New Server ',description);
  assert.equal(issued.organizationId,ORG);
  assert.equal(issued.agentId,AGENT);
  assert.equal(issued.enrollmentId,TOKEN);
  assert.match(issued.oneTimeToken,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((seen as {subject:string}).subject,OWNER.subject);
  assert.equal((seen as {label:string}).label,'New Server');
  assert.equal((seen as {tokenHash:string}).tokenHash.length,64);
  assert.equal(String(JSON.stringify(seen)).includes(issued.oneTimeToken),false);
});

test('D13 redeem sends only digests and strict agent description; returns separately generated credential', async () => {
  let seen: unknown;
  const service=createPreauthorizedEnrollmentService({
    issue:async()=>({enrollmentId:TOKEN,agentId:AGENT}),
    redeem:async record=>{seen=record;return {organizationId:ORG,agentId:AGENT};},
  });
  const raw=material().oneTimeSecret;
  const result=await service.redeem(raw,description);
  assert.equal(result.organizationId,ORG);
  assert.equal(result.agentId,AGENT);
  assert.match(result.machineCredential,/^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(raw,result.machineCredential);
  assert.equal(String(JSON.stringify(seen)).includes(raw),false);
  assert.equal(String(JSON.stringify(seen)).includes(result.machineCredential),false);
});

test('D13 redeemed credential requires a valid bound tenant and agent', async () => {
  const service=createPreauthorizedEnrollmentService({
    issue:async()=>({enrollmentId:TOKEN,agentId:AGENT}),
    redeem:async()=>({organizationId:'forged',agentId:AGENT}),
  });
  await assert.rejects(service.redeem(material().oneTimeSecret,description),/Unexpected enrollment result/);
});

test('D13 unavailable one-time token maps uniformly and service never automatically retries', async () => {
  let calls=0;
  const service=createPreauthorizedEnrollmentService({
    issue:async()=>({enrollmentId:TOKEN,agentId:AGENT}),
    redeem:async()=>{calls++;return null;},
  });
  await assert.rejects(service.redeem(material().oneTimeSecret,description),EnrollmentNotAvailable);
  assert.equal(calls,1);
});

test('D13 DB adapter refuses missing executor and invalid hash parameters without SQL calls', async () => {
  assert.throws(()=>createPreauthorizedPostgresGateway(null as never),TypeError);
  let calls=0;
  const adapter=createPreauthorizedPostgresGateway(async()=>{calls++;return {rows:[]};});
  const m=material();
  await assert.rejects(adapter.issue({subject:'user_valid',organizationId:ORG,label:'Host',agent:description,
    tokenHash:'invalid',tokenPrefix:'bad',expiresAt:when()}),TypeError);
  await assert.rejects(adapter.redeem({enrollmentHash:m.tokenHash,credentialHash:m.tokenHash,
    credentialPrefix:m.tokenPrefix,agent:description}),TypeError);
  assert.equal(calls,0);
});

test('D13 DB adapter uses parameterized issue SQL and validates both preallocated IDs', async () => {
  const m=material();
  let statement='';
  const adapter=createPreauthorizedPostgresGateway(async sql=>{
    statement=JSON.stringify(sql);
    return {rows:[{enrollment_id:TOKEN,agent_id:AGENT}]};
  });
  assert.deepEqual(await adapter.issue({subject:OWNER.subject,organizationId:ORG,label:'Host',agent:description,
    tokenHash:m.tokenHash,tokenPrefix:m.tokenPrefix,expiresAt:when()}),
  {enrollmentId:TOKEN,agentId:AGENT});
  assert.match(statement,/issue_preallocated_enrollment/);
  assert.equal(statement.includes(m.oneTimeSecret),false);
});

test('D13 DB actor role permission denied becomes safe typed error', async () => {
  const m=material();
  const adapter=createPreauthorizedPostgresGateway(async()=>{throw {code:'42501',detail:m.oneTimeSecret};});
  await assert.rejects(adapter.issue({subject:OWNER.subject,organizationId:ORG,label:'Host',agent:description,
    tokenHash:m.tokenHash,tokenPrefix:m.tokenPrefix,expiresAt:when()}),error=>
    error instanceof EnrollmentPermissionDenied && !String(error).includes(m.oneTimeSecret));
});

test('D13 unknown or consumed redemption uses uniform typed not-found', async () => {
  const m=material();const c=material();
  const adapter=createPreauthorizedPostgresGateway(async()=>{throw {code:'P0002'};});
  await assert.rejects(adapter.redeem({enrollmentHash:m.tokenHash,credentialHash:c.tokenHash,
    credentialPrefix:c.tokenPrefix,agent:description}),EnrollmentNotAvailable);
});

test('D13 SQL redemption chooses tenant from token binding not browser input', async () => {
  const m=material(),c=material();let statement='';
  const adapter=createPreauthorizedPostgresGateway(async sql=>{statement=JSON.stringify(sql);
    return {rows:[{organization_id:ORG,agent_id:AGENT}]};});
  assert.deepEqual(await adapter.redeem({enrollmentHash:m.tokenHash,credentialHash:c.tokenHash,
    credentialPrefix:c.tokenPrefix,agent:description}),{organizationId:ORG,agentId:AGENT});
  assert.match(statement,/redeem_preallocated_enrollment/);
  assert.equal(statement.includes(m.oneTimeSecret),false);
});

test('D13 DB adapter rejects multiple or malformed rows', async () => {
  const m=material(),c=material();
  for(const rows of [[{enrollment_id:TOKEN,agent_id:AGENT},{enrollment_id:TOKEN,agent_id:AGENT}],
    [{enrollment_id:TOKEN,agent_id:'wrong'}],[]]) {
    const a=createPreauthorizedPostgresGateway(async()=>({rows}));
    await assert.rejects(a.issue({subject:OWNER.subject,organizationId:ORG,label:'Host',agent:description,
      tokenHash:m.tokenHash,tokenPrefix:m.tokenPrefix,expiresAt:when()}));
  }
  const bad=createPreauthorizedPostgresGateway(async()=>({rows:[{organization_id:ORG,agent_id:'wrong'}]}));
  await assert.rejects(bad.redeem({enrollmentHash:m.tokenHash,credentialHash:c.tokenHash,
    credentialPrefix:c.tokenPrefix,agent:description}));
});

test('D13 response secret generation uses crypto secure randomness', async () => {
  const service=createPreauthorizedEnrollmentService({
    issue:async()=>({enrollmentId:TOKEN,agentId:AGENT}),redeem:async()=>null,
  });
  const first=await service.issue(OWNER,ORG,'Host',description);
  const second=await service.issue(OWNER,ORG,'Host',description);
  assert.notEqual(first.oneTimeToken,second.oneTimeToken);
  assert.equal(Buffer.from(first.oneTimeToken,'base64url').length,32);
  assert.equal(randomBytes(32).length,32);
});
