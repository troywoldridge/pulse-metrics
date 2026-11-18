import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  GOVERNANCE_PURPOSE, GOVERNANCE_ROSTER_DOMAIN, GOVERNANCE_REVIEW_DOMAIN,
  GOVERNANCE_ROSTER_FORMAT, GOVERNANCE_REVIEW_FORMAT,
  verifySignedTrustRoster, assessTwoPersonPilotReview,
} from './pilot-trust-governance.mjs';
import { canonicalJSON, approvalSigningBytes, APPROVAL_PURPOSE,
  REVIEWED_LOCAL_TARGET } from './pilot-authorization-policy.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const cli=join(here,'review-pilot-trust-governance.mjs');
const root=generateKeyPairSync('ed25519'), signer=generateKeyPairSync('ed25519');
const reviewer=generateKeyPairSync('ed25519'), other=generateKeyPairSync('ed25519');
const org='b5ab11cb-8784-4de3-873c-a9fdacfd083c';
const owner='80723197-9b64-4762-8bdd-08f474788c9a';
const agent='05cf23e1-92de-4cbb-a3a6-a33ecb6ad772';
const FIXED=Date.parse('2026-11-17T16:00:00.000Z');
const DATE=(n)=>new Date(n).toISOString();
const PUB=(k)=>k.publicKey.export({type:'spki',format:'pem'});
const SHA=(v)=>createHash('sha256').update(v).digest('hex');
const FP=(k)=>SHA(k.publicKey.export({type:'spki',format:'der'}));
const SIG=(k,domain,object)=>sign(null, Buffer.from(domain+canonicalJSON(object)),k.privateKey).toString('base64url');
const clone=(v)=>JSON.parse(JSON.stringify(v));

function bundle(now=FIXED) {
  const manifest={version:1,purpose:APPROVAL_PURPOSE,environment:'isolated-local-development',
    target:{...REVIEWED_LOCAL_TARGET},ownerUserId:owner,
    policy:{version:1,mode:'bounded',organizationId:org,agentId:agent,expectedSamplesMin:1,
      expectedSamplesMax:25,agentStatus:'active'},
    approval:{reviewId:'PM-2F2MTRIAL',reviewer:'reviewer-alpha',
      independentReview:'required-outside-database'},
    issuedAt:DATE(now-10*60_000),expiresAt:DATE(now+50*60_000)};
  const approval=canonicalJSON({format:'pulse-metrics/2f2i/ed25519-v1',manifest,
    signature:SIG(signer,'PULSE-METRICS/D15C-5U-2F2I/SIGNED-PROPOSAL/V1\n',manifest)});
  const key=(kp,id,role)=>({keyId:id,role,status:'active',publicKeyPem:PUB(kp),fingerprint:FP(kp),
    notBefore:DATE(now-6*3600_000),notAfter:DATE(now+12*3600_000)});
  const roster={version:1,purpose:GOVERNANCE_PURPOSE,environment:'isolated-local-development',
    target:{...REVIEWED_LOCAL_TARGET},serial:8,issuedAt:DATE(now-20*60_000),
    expiresAt:DATE(now+60*60_000),authorities:[key(signer,'signer-alpha','pilot-signer'),
      key(reviewer,'reviewer-alpha','independent-reviewer')]};
  const registry=canonicalJSON({format:GOVERNANCE_ROSTER_FORMAT,roster,
    signature:SIG(root,GOVERNANCE_ROSTER_DOMAIN,roster)});
  const review={reviewId:manifest.approval.reviewId,signerKeyId:'signer-alpha',reviewerKeyId:'reviewer-alpha',
    registrySerial:8,registrySha256:SHA(registry),approvalSha256:SHA(approval),
    decision:'review-only-confirmed',reviewedAt:DATE(now-5*60_000),expiresAt:DATE(now+25*60_000)};
  const reviewerAttestation=canonicalJSON({format:GOVERNANCE_REVIEW_FORMAT,review,
    signature:SIG(reviewer,GOVERNANCE_REVIEW_DOMAIN,review)});
  return {rawRegistry:registry,rootPublicPem:PUB(root),pinnedRootFingerprint:FP(root),
    minimumSerial:7,rawApproval:approval,rawReviewerAttestation:reviewerAttestation,now};
}
function resignRoster(input,edit){
  const r=JSON.parse(input.rawRegistry);edit(r.roster);
  r.signature=SIG(root,GOVERNANCE_ROSTER_DOMAIN,r.roster);
  return {...input,rawRegistry:canonicalJSON(r)};
}
function resignReviewer(input,edit){
  const r=JSON.parse(input.rawReviewerAttestation);edit(r.review);
  r.signature=SIG(reviewer,GOVERNANCE_REVIEW_DOMAIN,r.review);
  return {...input,rawReviewerAttestation:canonicalJSON(r)};
}
function rebindReviewerToRoster(input) {
  return resignReviewer(input,r=>{
    r.registrySha256=SHA(input.rawRegistry);
    r.registrySerial=JSON.parse(input.rawRegistry).roster.serial;
  });
}
function denied(f){assert.throws(f,/REFUSE_D15C5U2F2M|REFUSE_D15C5U2F2I/)}
function denyObject(b){denied(()=>assessTwoPersonPilotReview(b))}
function run(args){return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,
  env:{...process.env,NODE_OPTIONS:'',NODE_EXTRA_CA_CERTS:'',DATABASE_URL:'',MIGRATION_DATABASE_URL:''}})}
function temp(fn){const p=mkdtempSync(join(tmpdir(),'pulse-2f2m-'));try{return fn(p)}finally{rmSync(p,{recursive:true,force:true})}}

// 27 fail-closed tests, all offline and fully synthetic.
test('complete 2F2M scripts parse; CLI plan excludes operational authorization',()=>{
  for (const f of ['pilot-trust-governance.mjs','pilot-trust-governance.test.mjs','review-pilot-trust-governance.mjs']) {
    const p=spawnSync(process.execPath,['--check',join(here,f)],{encoding:'utf8'});
    assert.equal(p.status,0,p.stderr);
  }
  const p=run(['--plan']);assert.equal(p.status,0,p.stderr);
  assert.match(p.stdout,/NO POSTGRESQL/);assert.match(p.stdout,/NO PERSISTENT WRITES/);
});
test('valid synthetic three-signature chain is review-only, never authorized',()=>{
  assert.deepEqual(assessTwoPersonPilotReview(bundle()),{
    governanceSignatureVerified:true,proposalSignatureVerified:true,independentReviewSignatureVerified:true,
    distinctAuthorityKeys:true,serialFloorSatisfied:true,reviewOnly:true,
    operationalAuthorization:false,liveDatabaseAttested:false,realWorldSignerApproved:false});
});
test('root public fingerprint must be independently pinned, cannot be asserted by roster',()=>{
  const b=bundle();for(const bad of ['',FP(other),'0'.repeat(64),'A'.repeat(64),undefined]){
    denyObject({...b,pinnedRootFingerprint:bad});
  }
  denyObject({...b,rootPublicPem:PUB(other)});
});
test('root private signing key is never accepted as public authority',()=>{
  const b=bundle();denyObject({...b,rootPublicPem:root.privateKey.export({format:'pem',type:'pkcs8'})});
});
test('root signature fails if signed roster key, scope, serial, or status is altered',()=>{
  const b=bundle();const edits=[
    r=>r.serial++,r=>r.target.port=55434,r=>r.authorities[0].status='revoked',
    r=>r.authorities[1].keyId='new-reviewer',r=>r.purpose='other',r=>r.authorities[0].publicKeyPem=PUB(other),
  ];for(const edit of edits){const x=JSON.parse(b.rawRegistry);edit(x.roster);denyObject({...b,rawRegistry:canonicalJSON(x)})}
});
test('even ROOT-SIGNED revoked pilot signer is refused',()=>{
  denyObject(resignRoster(bundle(),r=>{r.authorities[0].status='revoked'}));
});
test('even ROOT-SIGNED revoked reviewer is refused',()=>{
  denyObject(resignRoster(bundle(),r=>{r.authorities[1].status='revoked'}));
});
test('wrong authority role, reused fingerprint and duplicated key ID refuse',()=>{
  for (const edit of [
    r=>r.authorities[0].role='independent-reviewer',
    r=>r.authorities[1].keyId=r.authorities[0].keyId,
    r=>{r.authorities[1].fingerprint=r.authorities[0].fingerprint},
    r=>{r.authorities[0].fingerprint=FP(root)},
  ])denyObject(resignRoster(bundle(),edit));
});
test('root-signed roster cannot include signer key equal to root governance key',()=>{
  denyObject(resignRoster(bundle(),r=>{
    r.authorities[0].publicKeyPem=PUB(root);r.authorities[0].fingerprint=FP(root);
  }));
});
test('independent serial floor blocks rollback to known lower signed roster serial',()=>{
  const b=bundle();denyObject({...b,minimumSerial:9});
  for (const bad of [0,-1,1.1,Number.MAX_SAFE_INTEGER+1,'7',undefined]){
    denyObject({...b,minimumSerial:bad});
  }
});
test('signed roster expired, not yet issued or longer than 24 hours refuses',()=>{
  const b=bundle();denyObject({...b,now:FIXED+61*60_000});
  denyObject({...b,now:FIXED-21*60_000});
  denyObject(resignRoster(b,r=>{r.expiresAt=DATE(FIXED+48*3600_000)}));
});
test('signed roster with wrong environment, database target, extra keys refuses',()=>{
  for(const edit of [r=>r.environment='production',r=>r.target.port=55432,
    r=>{r.unexpected=true},r=>{r.authorities[0].extra=true}]){
    denyObject(resignRoster(bundle(),edit));
  }
});
test('roster key validFrom / validUntil excludes old, future or invalid key use',()=>{
  for(const edit of [r=>r.authorities[0].notAfter=DATE(FIXED-1),
    r=>r.authorities[1].notBefore=DATE(FIXED+1),
    r=>r.authorities[0].notAfter=r.authorities[0].notBefore]){
    denyObject(resignRoster(bundle(),edit));
  }
});
test('reviewer signature rejects tampering with decision, expiry and references',()=>{
  const b=bundle();for(const edit of [r=>r.review.decision='authorizing',
    r=>r.review.registrySerial++,r=>r.review.approvalSha256='0'.repeat(64),
    r=>r.review.reviewId='PM-CHANGED',r=>r.review.expiresAt=DATE(FIXED+40*60_000)]){
    const obj=JSON.parse(b.rawReviewerAttestation);edit(obj);
    denyObject({...b,rawReviewerAttestation:canonicalJSON(obj)});
  }
});
test('valid reviewer signature with wrong proposal digest rejected',()=>{
  denyObject(resignReviewer(bundle(),r=>{r.approvalSha256='0'.repeat(64)}));
});
test('reviewer cannot countersign altered roster without updating exact digest',()=>{
  const b=resignRoster(bundle(),r=>r.serial=9);
  denyObject(b);
});
test('reviewer same as proposal signer is prohibited even when statement is re-signed',()=>{
  const b=resignReviewer(bundle(),r=>{r.reviewerKeyId=r.signerKeyId});denyObject(b);
});
test('independent reviewer signature required, signer signature cannot substitute',()=>{
  const b=bundle();const x=JSON.parse(b.rawReviewerAttestation);
  x.signature=SIG(signer,GOVERNANCE_REVIEW_DOMAIN,x.review);
  denyObject({...b,rawReviewerAttestation:canonicalJSON(x)});
});
test('signer must have been valid WHEN proposal was issued, not only now',()=>{
  const b=rebindReviewerToRoster(resignRoster(bundle(),r=>{
    r.authorities[0].notBefore=DATE(FIXED-7*60_000);
  }));
  denyObject(b);
});
test('reviewer must have been valid WHEN review occurred, not only now',()=>{
  const b=rebindReviewerToRoster(resignRoster(bundle(),r=>{
    r.authorities[1].notBefore=DATE(FIXED-3*60_000);
  }));
  denyObject(b);
});
test('roster issued AFTER purported signed proposal cannot retroactively authorize it',()=>{
  const b=rebindReviewerToRoster(resignRoster(bundle(),r=>{
    r.issuedAt=DATE(FIXED-8*60_000);
  }));
  denyObject(b);
});
test('signed review cannot be issued in future, expired, or exceed 60 minutes',()=>{
  const b=bundle();for(const edit of [r=>r.reviewedAt=DATE(FIXED+1),
    r=>r.expiresAt=DATE(FIXED-1),r=>r.expiresAt=DATE(FIXED+60*60_000),
    r=>r.reviewedAt=DATE(FIXED-21*60_000)]){
    denyObject(resignReviewer(b,edit));
  }
});
test('reviewed signature must match 2F2I proposal, not self-asserted key identity',()=>{
  const b=bundle();const raw=JSON.parse(b.rawApproval);
  raw.manifest.ownerUserId='80723197-9b64-4762-8bdd-08f474788c9b';
  denyObject({...b,rawApproval:canonicalJSON(raw)});
});
test('wrong signer in governance roster fails 2F2I verification',()=>{
  const b=resignRoster(bundle(),r=>{
    r.authorities[0].publicKeyPem=PUB(other);r.authorities[0].fingerprint=FP(other);
  });
  // Reviewer digest was of previous roster: rejected even before 2F2I signature.
  denyObject(b);
});
test('CLI refuses missing, unknown, or combined modes before file/network',()=>{
  for(const args of [[],['--bogus'],['--plan','--review-offline'],['--review-offline']]){
    const p=run(args);assert.notEqual(p.status,0);assert.match(p.stderr,/REFUSE_D15C5U2F2M/);
  }
});
test('CLI rejects symlinked or group-readable files, relative paths, extra arguments',()=>{
  temp(d=>{
    const b=bundle(Date.now());const files=[join(d,'root'),join(d,'roster'),join(d,'proposal'),join(d,'review')];
    [b.rootPublicPem,b.rawRegistry,b.rawApproval,b.rawReviewerAttestation].forEach((v,i)=>writeFileSync(files[i],v,{mode:0o600}));
    const args=['--review-offline',...files,b.pinnedRootFingerprint,String(b.minimumSerial)];
    const ok=run(args);assert.equal(ok.status,0,ok.stderr);
    assert.match(ok.stdout,/NO AUTHORIZATION/);
    assert.doesNotMatch(ok.stdout,new RegExp(org));
    assert.doesNotMatch(ok.stdout,/[A-Za-z0-9_-]{86}/);
    const fail=run([...args,'extra']);assert.notEqual(fail.status,0);
    const link=join(d,'root-link');symlinkSync(files[0],link);
    assert.notEqual(run(['--review-offline',link,...files.slice(1),b.pinnedRootFingerprint,String(b.minimumSerial)]).status,0);
    assert.notEqual(run(['--review-offline','relative',...files.slice(1),b.pinnedRootFingerprint,String(b.minimumSerial)]).status,0);
    const publicRead=join(d,'public');writeFileSync(publicRead,b.rootPublicPem,{mode:0o600});
    chmodSync(publicRead,0o644); // Explicit override: parent wrapper uses umask 077.
    assert.notEqual(run(['--review-offline',publicRead,...files.slice(1),b.pinnedRootFingerprint,String(b.minimumSerial)]).status,0);
  });
});
test('CLI refuses untrusted root hash or stale serial with no sensitive diagnostics',()=>{
  temp(d=>{
    const b=bundle(Date.now());const files=[join(d,'root'),join(d,'roster'),join(d,'proposal'),join(d,'review')];
    [b.rootPublicPem,b.rawRegistry,b.rawApproval,b.rawReviewerAttestation].forEach((v,i)=>writeFileSync(files[i],v,{mode:0o600}));
    for (const [h,s] of [[FP(other),'7'],[FP(root),'9']]){
      const p=run(['--review-offline',...files,h,s]);
      assert.notEqual(p.status,0);
      assert.match(p.stderr,/NO AUTHORIZATION/);
      assert.doesNotMatch(p.stderr,new RegExp(org));
    }
  });
});
