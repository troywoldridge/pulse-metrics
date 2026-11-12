import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redeemAndInstallVerifiedMachineIdentity } from './enrollment-workflow.js';
import { readMachineCredential, credentialLocation } from '../security/credential-vault.js';
import { AgentHttpsEnrollmentError } from './https-redemption.js';

const ORG = 'a9827cff-c4a4-4c36-8ec0-dae0e9933d08';
const AGENT = '153bd92f-47c4-4de2-95e0-a042ea8bcb3a';
const token = () => randomBytes(32).toString('base64url');
const agent = { displayName: 'Synthetic Workflow Linux', hostname: 'workflow.invalid',
  platform: 'linux' as const, architecture: 'x86_64' as const };
const receipt = () => ({ organizationId: ORG, agentId: AGENT, machineCredential: token() });
let root = '';
let ca = '';
let key = '';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulse-d12-workflow-'));
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1',
    '-subj','/CN=synthetic.invalid','-addext','subjectAltName=IP:127.0.0.1'],
    { stdio:'ignore', timeout: 20000 });
  ca = await readFile(join(root,'cert.pem'),'utf8');
  key = await readFile(join(root,'key.pem'),'utf8');
});
after(async () => { if (root) await rm(root, {recursive:true, force:true}); });

async function serve(response: unknown) {
  let received = 0;
  const s = https.createServer({key,cert:ca}, (_req,res) => {
    received++;
    res.writeHead(201, {'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve,reject) => {s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  const addr = s.address();
  assert.ok(addr && typeof addr !== 'string');
  return { origin: `https://127.0.0.1:${addr.port}`, get calls(){return received;}, close: async () => {
    s.closeAllConnections();
    await new Promise<void>((resolve,reject) => s.close(e=>e?reject(e):resolve()));
  } };
}

function options(expectedOrigin:string, directory:string) {
  return {expectedOrigin,credentialDirectory: directory, expectedOrganizationId:ORG,
    expectedAgentId:AGENT,oneTimeToken:token(),agent,trustedCaPem:ca};
}
const denied = (task:Promise<unknown>) => assert.rejects(task,AgentHttpsEnrollmentError);

test('D12 valid verified HTTPS enrollment installs only metadata into response and secret in 0600 vault', async () => {
  const r = receipt();
  const s = await serve(r);
  const directory = join(root,'storage-a');
  try {
    assert.deepEqual(await redeemAndInstallVerifiedMachineIdentity(options(s.origin,directory)),
      {organizationId: ORG, agentId: AGENT});
    assert.deepEqual(await readMachineCredential(directory),r);
    assert.equal((await lstat(directory)).mode & 0o777,0o700);
    assert.equal((await lstat(credentialLocation(directory))).mode & 0o777,0o600);
    assert.equal(s.calls,1);
  } finally {await s.close();}
});

test('D12 existing credential is refused BEFORE remote one-time token is consumed', async () => {
  const s = await serve(receipt());
  try {
    await denied(redeemAndInstallVerifiedMachineIdentity(options(s.origin,join(root,'storage-a'))));
    assert.equal(s.calls,0);
  } finally {await s.close();}
});

test('D12 mismatched expected agent is refused and no new local credential is installed', async () => {
  const s = await serve({...receipt(),agentId:'55c52f44-8372-4edc-8346-4d5ace9cfde3'});
  const directory=join(root,'storage-mismatch');
  try {
    await denied(redeemAndInstallVerifiedMachineIdentity(options(s.origin,directory)));
    await assert.rejects(lstat(credentialLocation(directory)),{code:'ENOENT'});
    assert.equal(s.calls,1);
  } finally {await s.close();}
});

test('D12 cannot bypass independent expectedAgentId during vault installation', async () => {
  const s = await serve(receipt());
  const directory=join(root,'storage-unknown');
  try {
    await denied(redeemAndInstallVerifiedMachineIdentity({...options(s.origin,directory),expectedAgentId:''}));
    assert.equal(s.calls,0);
  } finally {await s.close();}
});

test('D12 local storage failure is sanitized, makes no second network attempt and never logs secrets', async () => {
  const r=receipt();
  const s=await serve(r);
  const directory=join(root,'not-a-directory');
  const original=console.log;
  const printed:string[]=[];
  console.log=(...args:unknown[])=>{printed.push(args.join(' '));};
  try {
    // The parent file is not an allowable directory; installation must fail.
    const {writeFile}=await import('node:fs/promises');
    await writeFile(directory,'synthetic blocker');
    const t=token();
    await assert.rejects(redeemAndInstallVerifiedMachineIdentity(
      {...options(s.origin,directory),oneTimeToken:t}),error=>{
        assert.ok(error instanceof AgentHttpsEnrollmentError);
        assert.equal(String(error).includes(t),false);
        assert.equal(String(error).includes(r.machineCredential),false);
        return true;
      });
    assert.equal(s.calls,0,'preflight must reject a non-directory before redeeming');
    assert.equal(printed.some(x=>x.includes(t)||x.includes(r.machineCredential)),false);
  } finally {console.log=original;await s.close();}
});
