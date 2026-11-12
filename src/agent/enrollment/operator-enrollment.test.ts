import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrollWithOperatorToken, OperatorEnrollmentError } from './operator-enrollment.js';
import { readMachineCredential, credentialLocation } from '../security/credential-vault.js';

const ORG = 'a9827cff-c4a4-4c36-8ec0-dae0e9933d08';
const AGENT = '153bd92f-47c4-4de2-95e0-a042ea8bcb3a';
const FOREIGN = 'e56b08c7-dd64-4386-8fd5-f6f51f295510';
const agent = { displayName:'D14 Operator Synthetic Linux', hostname:'operator.invalid',
  platform:'linux' as const, architecture:'x86_64' as const };
function secret() { return randomBytes(32).toString('base64url'); }
function receipt() { return { organizationId: ORG, agentId: AGENT, machineCredential: secret() }; }
let root = '', ca = '', key = '';

before(async () => {
  root = await mkdtemp(join(tmpdir(),'pulse-d14-operator-'));
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1',
    '-subj','/CN=operator.invalid','-addext','subjectAltName=IP:127.0.0.1'],
    { stdio:'ignore', timeout:20000 });
  key = await readFile(join(root,'key.pem'),'utf8');
  ca = await readFile(join(root,'cert.pem'),'utf8');
});
after(async () => { if (root) await rm(root,{recursive:true,force:true}); });

async function serve(body: unknown, status = 201) {
  let calls = 0;
  let postedToken: string | undefined;
  const server = https.createServer({key,cert:ca}, (req,res) => {
    calls++;
    assert.equal(req.url, '/api/agent-enrollments/redeem');
    let received = '';
    req.on('data', chunk => { received += chunk.toString('utf8'); });
    req.on('end', () => {
      const json = JSON.parse(received);
      postedToken = json.token;
      assert.deepEqual(json.agent, agent);
      res.writeHead(status, { 'Content-Type':'application/json','Cache-Control':'no-store' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve,reject) => {
    server.once('error',reject); server.listen(0,'127.0.0.1',resolve);
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  return { origin:`https://127.0.0.1:${addr.port}`,
    get calls(){return calls;}, get postedToken(){return postedToken;},
    async close() {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));} };
}
function options(origin: string, dir: string) {
  return {expectedOrigin:origin,expectedOrganizationId:ORG,expectedAgentId:AGENT,
    credentialDirectory:dir,agent,trustedCaPem:ca};
}
const denied = (task:Promise<unknown>) => assert.rejects(task, OperatorEnrollmentError);

test('D14 hidden operator handoff -> verified HTTPS -> exact preallocated identity -> 0600 vault', async () => {
  const issuedSecret = secret();
  const response = receipt();
  const s = await serve(response);
  const directory = join(root,'valid-machine');
  let reads = 0;
  try {
    const output = await enrollWithOperatorToken(options(s.origin,directory),async()=>{ reads++; return issuedSecret; });
    assert.deepEqual(output,{ organizationId:ORG,agentId:AGENT });
    assert.equal(reads,1);
    assert.equal(s.calls,1);
    assert.equal(s.postedToken,issuedSecret);
    assert.deepEqual(await readMachineCredential(directory),response);
    assert.equal((await lstat(directory)).mode & 0o777,0o700);
    assert.equal((await lstat(credentialLocation(directory))).mode & 0o777,0o600);
  } finally {await s.close();}
});

test('D14 refuses existing credential before reading or transmitting one-time token', async () => {
  const s = await serve(receipt());
  let reads = 0;
  try {
    await denied(enrollWithOperatorToken(options(s.origin,join(root,'valid-machine')),
      async()=>{reads++;return secret();}));
    assert.equal(reads,0);
    assert.equal(s.calls,0);
  } finally { await s.close(); }
});

test('D14 wrong redeemed agent ID cannot be persisted; one network attempt only', async () => {
  const s = await serve({...receipt(),agentId:FOREIGN});
  const dir = join(root,'wrong-agent');
  try {
    await denied(enrollWithOperatorToken(options(s.origin,dir),async()=>secret()));
    assert.equal(s.calls,1);
    await assert.rejects(lstat(credentialLocation(dir)),{code:'ENOENT'});
  } finally {await s.close();}
});

test('D14 foreign organization receipt cannot be persisted', async () => {
  const s = await serve({...receipt(),organizationId:FOREIGN});
  try {
    await denied(enrollWithOperatorToken(options(s.origin,join(root,'wrong-org')),async()=>secret()));
    assert.equal(s.calls,1);
  } finally {await s.close();}
});

test('D14 refuses malformed token without network attempt or secret in error', async () => {
  const s = await serve(receipt());
  try {
    await denied(enrollWithOperatorToken(options(s.origin,join(root,'bad-token')),async()=> 'bad'));
    assert.equal(s.calls,0);
  } finally {await s.close();}
});

test('D14 failed HTTPS response is never auto retried; no token in diagnostics', async () => {
  const s = await serve({error:'unavailable'},503);
  const t = secret();
  const original = console.log;
  const outputs:string[]=[];
  console.log=(...args:unknown[])=>{outputs.push(args.join(' '));};
  try {
    await assert.rejects(enrollWithOperatorToken(options(s.origin,join(root,'server-error')),
      async()=>t),e => e instanceof OperatorEnrollmentError && !String(e).includes(t));
    assert.equal(s.calls,1);
    assert.equal(outputs.length,0);
  } finally {console.log=original;await s.close();}
});

test('D14 missing independently confirmed agent ID refuses before secret read', async () => {
  let reads=0;
  await denied(enrollWithOperatorToken({ ...options('https://127.0.0.1:444',join(root,'no-id')),expectedAgentId:'' },
    async()=>{reads++;return secret();}));
  assert.equal(reads,0);
});

test('D14 token input error is sanitized and never calls HTTPS', async () => {
  const s = await serve(receipt());
  const t = secret();
  try {
    await assert.rejects(enrollWithOperatorToken(options(s.origin,join(root,'token-error')),
      async()=>{throw new Error(`accidental failure ${t}`);}), e =>
      e instanceof OperatorEnrollmentError && !String(e).includes(t));
    assert.equal(s.calls,0);
  } finally {await s.close();}
});

test('D14 executable CLI reads inherited protected FD 3, enrolls once, and outputs only nonsecret IDs', async () => {
  const t = secret();
  const response = receipt();
  const service = await serve(response);
  const directory = join(root,'fd3-cli');
  const tokenPath = join(root,'token-fd3-0600');
  await writeFile(tokenPath,t + '\n',{mode:0o600});
  const fd = openSync(tokenPath,'r');
  const scriptIsTs = fileURLToPath(import.meta.url).endsWith('.ts');
  const cliPath = fileURLToPath(new URL(scriptIsTs ? './operator-cli.ts' : './operator-cli.js', import.meta.url));
  const command = [
    ...(scriptIsTs ? ['--import','tsx'] : []), cliPath,
    '--origin',service.origin,'--organization-id',ORG,'--agent-id',AGENT,
    '--credential-dir',directory,'--display-name',agent.displayName,
    '--hostname',agent.hostname,'--architecture',agent.architecture,
    '--trusted-ca-file',join(root,'cert.pem'),'--token-source','fd3',
  ];
  try {
    const child = spawn(process.execPath,command,{stdio:['ignore','pipe','pipe',fd],cwd:process.cwd()});
    if (!child.stdout || !child.stderr) throw new Error('CLI child stdio unavailable');
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',x=>{stdout+=x;});
    child.stderr.on('data',x=>{stderr+=x;});
    const code = await new Promise<number>((resolve,reject)=>{
      child.once('error',reject);
      child.once('close', (exit)=>resolve(exit??1));
    });
    assert.equal(code,0,stderr);
    assert.deepEqual(JSON.parse(stdout.trim()),{status:'enrolled',organizationId:ORG,agentId:AGENT});
    assert.equal(stdout.includes(t) || stderr.includes(t) || stdout.includes(response.machineCredential),false);
    assert.deepEqual(await readMachineCredential(directory),response);
    assert.equal(service.calls,1);
    assert.equal(service.postedToken,t);
  } finally {closeSync(fd);await service.close();}
});
