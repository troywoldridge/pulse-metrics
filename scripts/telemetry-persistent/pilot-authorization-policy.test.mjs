import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_PURPOSE, REVIEWED_LOCAL_TARGET, canonicalJSON,
  parseCanonicalJSON, validatePilotManifest, approvalSigningBytes,
  trustedPublicKeyFingerprint, verifySignedPilotApproval, assessSignedFixture,
} from './pilot-authorization-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'review-pilot-authorization.mjs');
const org = 'b5ab11cb-8784-4de3-873c-a9fdacfd083c';
const agent = '05cf23e1-92de-4cbb-a3a6-a33ecb6ad772';
const owner = '80723197-9b64-4762-8bdd-08f474788c9a';
const issue = '2026-11-17T10:00:00.000Z';
const expiry = '2026-11-18T09:00:00.000Z';
const now = Date.parse('2026-11-17T11:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const pub = keys.publicKey.export({ type: 'spki', format: 'pem' });
const fp = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const alternate = generateKeyPairSync('ed25519');

function proposal() {
  return {
    version: 1,
    purpose: APPROVAL_PURPOSE,
    environment: 'isolated-local-development',
    target: { ...REVIEWED_LOCAL_TARGET },
    ownerUserId: owner,
    policy: { version: 1, mode: 'bounded', organizationId: org,
      agentId: agent, expectedSamplesMin: 1, expectedSamplesMax: 10,
      agentStatus: 'active' },
    approval: { reviewId: 'PM-2F2I2026', reviewer: 'independent-reviewer',
      independentReview: 'required-outside-database' },
    issuedAt: issue,
    expiresAt: expiry,
  };
}
function signed(proposed = proposal()) {
  const signature = sign(null, approvalSigningBytes(proposed), keys.privateKey).toString('base64url');
  return canonicalJSON({ format: 'pulse-metrics/2f2i/ed25519-v1',
    manifest: proposed, signature });
}
function fixture() {
  return {
    version: 1, organizationIds: [org], userCount: 1, membershipCount: 1,
    agents: [{ organizationId: org, agentId: agent, status: 'active' }],
    credentials: [{ organizationId: org, agentId: agent, revoked: false, scopes: ['telemetry:write'] }],
    sampleCount: 3, submissionCount: 3,
    samplesByAgent: [{ organizationId: org, agentId: agent, count: 3 }],
    orphanSamples: 0, mismatchedLedger: 0, unownedTelemetry: 0,
    unscopedVisibleSamples: 0, rlsViolations: 0, unsafeRoles: 0,
    migrationReceiptErrors: 0, runtimeCredentialRead: false,
    runtimeDirectTelemetryInsert: false,
  };
}
function denied(fn) { assert.throws(fn, /REFUSE_D15C5U2F2I|REFUSE_D15C5U2F2G_POLICY/); }
function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_EXTRA_CA_CERTS: '',
      DATABASE_URL: '', MIGRATION_DATABASE_URL: '' } });
}
function tempFiles(fn) {
  const d = mkdtempSync(join(tmpdir(), 'pulse-2f2i-'));
  try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
}

test('2F2I complete modules parse and use only offline built-ins and 2F2G policy', () => {
  for (const file of ['pilot-authorization-policy.mjs','pilot-authorization-policy.test.mjs',
    'review-pilot-authorization.mjs']) {
    const p = spawnSync(process.execPath, ['--check', join(here, file)], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
  }
  const p = run(['--plan']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /NO PERSISTENT WRITES/);
  assert.match(p.stdout, /NO AGENT ENROLLMENT/);
});

test('signed independent Ed25519 proposal validates with external fingerprint', () => {
  assert.equal(trustedPublicKeyFingerprint(pub).hash, fp);
  const decision = verifySignedPilotApproval(signed(), pub, fp, now);
  assert.equal(decision.verifiedSignature, true);
  assert.equal(decision.reviewOnly, true);
  assert.equal(decision.ownerUserId, owner);
  assert.deepEqual(decision.policy, proposal().policy);
});

test('exact signed scope can match a synthetic fixture without becoming operational authorization', () => {
  assert.deepEqual(assessSignedFixture(signed(), pub, fp, fixture(), now),
    { fixtureMatchesPolicy: true, signatureVerified: true, operationalAuthorization: false });
});

test('unsigned canonical request validates but is not a signed approval', () => {
  const draft = proposal();
  assert.deepEqual(validatePilotManifest(parseCanonicalJSON(canonicalJSON(draft))), draft);
  tempFiles(d => {
    const file = join(d, 'draft.json');
    writeFileSync(file, canonicalJSON(draft), { mode: 0o600 });
    const p = run(['--check-draft', file]);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /NOT AN APPROVAL/);
  });
});

test('review CLI verifies signature only; refuses to authorize runtime', () => {
  tempFiles(d => {
    const envFile = join(d,'approval.json');
    const keyFile = join(d,'key.pem');
    writeFileSync(envFile, signed(), { mode: 0o600 });
    writeFileSync(keyFile, pub, { mode: 0o600 });
    const ok = run(['--review-signed-offline',envFile,keyFile,fp]);
    assert.equal(ok.status,0,ok.stderr);
    assert.match(ok.stdout,/NO RUNTIME AUTHORIZATION/);
    assert.doesNotMatch(ok.stdout, new RegExp(org));
    assert.doesNotMatch(ok.stdout, new RegExp(agent));
    const deniedKey = run(['--review-signed-offline',envFile,keyFile,'0'.repeat(64)]);
    assert.notEqual(deniedKey.status,0);
    assert.match(deniedKey.stderr,/REFUSE_D15C5U2F2I/);
  });
});

test('signature from a different Ed25519 key is denied', () => {
  const wrongPem = alternate.publicKey.export({ type:'spki', format:'pem' });
  denied(() => verifySignedPilotApproval(signed(), wrongPem, fp, now));
  const wrongFp = createHash('sha256').update(alternate.publicKey.export({type:'spki',format:'der'})).digest('hex');
  denied(() => verifySignedPilotApproval(signed(), wrongPem, wrongFp, now));
});

test('private signing keys cannot masquerade as public trust anchors', () => {
  const privatePem=keys.privateKey.export({type:'pkcs8',format:'pem'});
  denied(()=>verifySignedPilotApproval(signed(),privatePem,fp,now));
});

test('trust anchor missing, malformed or self-asserted mismatched hash is denied', () => {
  for (const hash of [undefined, null, '', 'A'.repeat(64), '0'.repeat(64), fp + '0']) {
    denied(() => verifySignedPilotApproval(signed(), pub, hash, now));
  }
});

test('altered signed agent, organization, owner or sample cap is denied', () => {
  for (const change of [
    m => {m.policy.agentId='05cf23e1-92de-4cbb-a3a6-a33ecb6ad773';},
    m => {m.policy.organizationId='b5ab11cb-8784-4de3-873c-a9fdacfd083d';},
    m => {m.ownerUserId='80723197-9b64-4762-8bdd-08f474788c9b';},
    m => {m.policy.expectedSamplesMax=9;},
  ]) {
    const env = JSON.parse(signed());
    change(env.manifest);
    denied(() => verifySignedPilotApproval(canonicalJSON(env), pub, fp, now));
  }
});

test('invalid or expired review window is refused', () => {
  denied(() => verifySignedPilotApproval(signed(),pub,fp,Date.parse(expiry)));
  denied(() => verifySignedPilotApproval(signed(),pub,fp,Date.parse(issue)-1));
  denied(() => verifySignedPilotApproval(signed(),pub,fp,-1));
  denied(() => verifySignedPilotApproval(signed(),pub,fp,NaN));
  const tooLong = proposal();tooLong.expiresAt='2026-11-19T11:00:00.000Z';
  denied(() => approvalSigningBytes(tooLong));
  const reversed = proposal();reversed.expiresAt=issue;
  denied(() => approvalSigningBytes(reversed));
});

test('fixed private database identity cannot be changed', () => {
  for(const [key,val] of [
    ['database','postgres'], ['dataDirectory','/tmp/other'],
    ['socketDirectory','/tmp'], ['port',55432], ['transport','tcp'],
  ]) {
    const p=proposal();p.target[key]=val;
    denied(() => validatePilotManifest(p));
  }
});

test('wrong environment, purpose, explicit identity or extra fields rejected', () => {
  for(const edit of [
    p=>{p.purpose='production';},p=>{p.environment='production';},
    p=>{p.ownerUserId='00000000-0000-0000-0000-000000000000';},
    p=>{p.rootCredential='secret';},p=>{p.policy.extra='insecure';},
    p=>{p.target.tcp=true;},p=>{p.approval.admin=true;},
  ]) {
    const p=proposal();edit(p);denied(()=>validatePilotManifest(p));
  }
});

test('only active and at most 100 samples; no zero, second agent or pending status', () => {
  for (const edit of [
    p=>{p.policy.agentStatus='revoked';},
    p=>{p.policy.agentStatus='pending';},
    p=>{p.policy.expectedSamplesMin=0;},
    p=>{p.policy.expectedSamplesMax=101;},
    p=>{p.policy.agents=[agent,agent];},
  ]) { const p=proposal();edit(p);denied(()=>validatePilotManifest(p)); }
});

test('review metadata required but never sufficient by itself', () => {
  for(const edit of [
    p=>{p.approval.reviewId='not-reviewed';},
    p=>{p.approval.reviewer='';},
    p=>{p.approval.independentReview='self-approved';},
  ]) { const p=proposal();edit(p);denied(()=>validatePilotManifest(p)); }
});

test('duplicate JSON keys, whitespace and noncanonical ordering rejected', () => {
  const canonical = signed();
  denied(() => parseCanonicalJSON('  '+canonical+'\n'));
  denied(() => parseCanonicalJSON(canonical.replace('"format":', '"format":"x","format":')));
  denied(() => parseCanonicalJSON(JSON.stringify({ signature: JSON.parse(canonical).signature,
    manifest: JSON.parse(canonical).manifest, format: 'pulse-metrics/2f2i/ed25519-v1' })));
  denied(() => parseCanonicalJSON('{"__proto__":{},"bad":true}'));
  denied(() => parseCanonicalJSON('x'.repeat(8300)));
});

test('signature envelope must have exact fields and valid detached Ed25519 signature', () => {
  const env=JSON.parse(signed());env.x=1;
  denied(()=>verifySignedPilotApproval(canonicalJSON(env),pub,fp,now));
  const env2=JSON.parse(signed());env2.format='unknown';
  denied(()=>verifySignedPilotApproval(canonicalJSON(env2),pub,fp,now));
  const env3=JSON.parse(signed());env3.signature='a';
  denied(()=>verifySignedPilotApproval(canonicalJSON(env3),pub,fp,now));
  const env4=JSON.parse(signed());env4.signature=(env4.signature[0]==='A'?'B':'A')+env4.signature.slice(1);
  denied(()=>verifySignedPilotApproval(canonicalJSON(env4),pub,fp,now));
});

test('RSA authority is rejected even with a matching SPKI SHA256', () => {
  const rsa=generateKeyPairSync('rsa',{ modulusLength:2048 });
  const pem=rsa.publicKey.export({type:'spki',format:'pem'});
  const digest=createHash('sha256').update(rsa.publicKey.export({type:'spki',format:'der'})).digest('hex');
  denied(()=>verifySignedPilotApproval(signed(),pem,digest,now));
});

test('forged or broadened fixture cannot bypass a valid signed review', () => {
  const cases=[
    f=>{f.organizationIds=['b5ab11cb-8784-4de3-873c-a9fdacfd083d'];},
    f=>{f.agents[0].agentId='05cf23e1-92de-4cbb-a3a6-a33ecb6ad773';},
    f=>{f.userCount=2;},
    f=>{f.membershipCount=2;},
    f=>{f.sampleCount=11;f.submissionCount=11;f.samplesByAgent[0].count=11;},
    f=>{f.orphanSamples=1;},
    f=>{f.runtimeCredentialRead=true;},
    f=>{f.rlsViolations=1;},
  ];
  for(const edit of cases) {
    const f=fixture();edit(f);denied(()=>assessSignedFixture(signed(),pub,fp,f,now));
  }
});

test('offline CLI refuses missing/unknown/unsafe invocation and never reads symlinks',()=>{
  for(const args of [[],['--write'],['--enroll'],['--start'],['--plan','extra'],
    ['--check-draft','relative.json'],['--review-signed-offline']]) {
    const result=run(args);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/REFUSE_D15C5U2F2I/);
  }
  tempFiles(d=>{
    const draft=join(d,'draft.json');const link=join(d,'linked.json');
    writeFileSync(draft,canonicalJSON(proposal()),{mode:0o600});
    symlinkSync(draft,link);
    const result=run(['--check-draft',link]);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/REFUSE_D15C5U2F2I/);
  });
});

test('2F2I cannot spawn psql, sudo or invoke existing start operator',()=>{
  const sources=[
    'pilot-authorization-policy.mjs',
    'review-pilot-authorization.mjs',
  ].map(name=>spawnSync('cat',[join(here,name)],{encoding:'utf8'}).stdout).join('\n');
  for(const term of ['child_process','execSync','spawnSync','sudo -u','pg_ctl',
    'psql -','INSERT INTO','CREATE ROLE','PULSE_APPROVE_5U2F2H_LIVE_EMPTY_INVENTORY']) {
    assert.equal(sources.includes(term),false,`not allowed: ${term}`);
  }
});
