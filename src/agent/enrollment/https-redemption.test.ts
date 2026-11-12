import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redeemEnrollmentOverVerifiedHttps, AgentHttpsEnrollmentError } from './https-redemption.js';

const ORG = 'a9827cff-c4a4-4c36-8ec0-dae0e9933d08';
const AGENT = '153bd92f-47c4-4de2-95e0-a042ea8bcb3a';
const token = () => randomBytes(32).toString('base64url');
const description = { displayName: 'Synthetic HTTPS Linux', hostname: 'synthetic.invalid', platform: 'linux' as const, architecture: 'x86_64' as const };
let fixtureDir = '';
let serverCert = '';
let serverKey = '';
let wrongCert = '';
let wrongKey = '';

before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'pulse-d12-tls-'));
  const create = (name: string, alternative: string) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(fixtureDir, `${name}.key`), '-out', join(fixtureDir, `${name}.pem`),
      '-days', '1', '-subj', `/CN=${name}.invalid`, '-addext', `subjectAltName=${alternative}`],
      { stdio: 'ignore', timeout: 20000 });
  };
  create('good', 'IP:127.0.0.1');
  create('wrong', 'DNS:wrong.invalid');
  serverCert = await readFile(join(fixtureDir, 'good.pem'), 'utf8');
  serverKey = await readFile(join(fixtureDir, 'good.key'), 'utf8');
  wrongCert = await readFile(join(fixtureDir, 'wrong.pem'), 'utf8');
  wrongKey = await readFile(join(fixtureDir, 'wrong.key'), 'utf8');
});

after(async () => { if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }); });

type Handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;

async function server(handler: Handler, wrong = false) {
  const service = https.createServer({ key: wrong ? wrongKey : serverKey, cert: wrong ? wrongCert : serverCert }, handler);
  await new Promise<void>((resolve, reject) => {
    service.once('error', reject);
    service.listen(0, '127.0.0.1', resolve);
  });
  const address = service.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `https://127.0.0.1:${address.port}`,
    close: async () => {
      service.closeAllConnections();
      await new Promise<void>((resolve, reject) => service.close(err => err ? reject(err) : resolve()));
    },
  };
}

function receipt() { return { organizationId: ORG, agentId: AGENT, machineCredential: token() }; }
function opts(origin: string, oneTimeToken = token(), ca = serverCert) {
  return { expectedOrigin: origin, oneTimeToken, agent: description,
    expectedOrganizationId: ORG, expectedAgentId: AGENT, trustedCaPem: ca, timeoutMs: 2500 };
}
function goodResponse(res: import('node:http').ServerResponse, body: unknown, headers: Record<string,string> = {}) {
  res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const denied = (promise: Promise<unknown>, secret?: string) => assert.rejects(promise, error => {
  assert.ok(error instanceof AgentHttpsEnrollmentError);
  if (secret) assert.equal(String(error).includes(secret), false);
  return true;
});

test('D12 HTTPS verifies CA and hostname and uses only fixed redemption path', async () => {
  const t = token();
  const r = receipt();
  let calls = 0;
  const s = await server((req, res) => {
    calls++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/agent-enrollments/redeem');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['cache-control'], 'no-store');
    let body = '';
    req.on('data', chunk => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.deepEqual(parsed, { token: t, agent: description });
      goodResponse(res, r);
    });
  });
  try {
    assert.deepEqual(await redeemEnrollmentOverVerifiedHttps(opts(s.origin, t)), r);
    assert.equal(calls, 1);
  } finally { await s.close(); }
});

test('D12 rejects self-signed/untrusted TLS without explicitly reviewed CA', async () => {
  const s = await server((_req, res) => goodResponse(res, receipt()));
  try { await denied(redeemEnrollmentOverVerifiedHttps({ ...opts(s.origin), trustedCaPem: undefined })); }
  finally { await s.close(); }
});

test('D12 rejects trusted CA whose server certificate hostname is wrong', async () => {
  let requests = 0;
  const s = await server((_req, res) => { requests++; goodResponse(res, receipt()); }, true);
  try {
    await denied(redeemEnrollmentOverVerifiedHttps(opts(s.origin, token(), wrongCert)));
    assert.equal(requests, 0, 'HTTP body must not reach host-mismatched origin');
  } finally { await s.close(); }
});

test('D12 refuses HTTP and noncanonical or credential-bearing HTTPS origins before networking', async () => {
  for (const origin of ['http://127.0.0.1:443', 'https://example.invalid/',
    'https://example.invalid/path', 'https://example.invalid/?token=secret',
    'https://user:password@example.invalid', 'https://example.invalid#frag',
    'https://EXAMPLE.invalid', 'https://example.invalid:443', '', 'ftp://example.invalid']) {
    await denied(redeemEnrollmentOverVerifiedHttps(opts(origin)), 'secret');
  }
});

test('D12 never follows redirects and never sends a second token-bearing request', async () => {
  let second = 0;
  const sink = await server((_req, res) => { second++; goodResponse(res, receipt()); });
  const redirector = await server((_req, res) => { res.writeHead(307, { Location: `${sink.origin}/api/agent-enrollments/redeem` }); res.end(); });
  try {
    const t = token();
    await denied(redeemEnrollmentOverVerifiedHttps(opts(redirector.origin, t)), t);
    assert.equal(second, 0);
  } finally { await redirector.close(); await sink.close(); }
});

test('D12 rejects HTTP status, cache, media type and compressed response violations', async () => {
  const cases: Handler[] = [
    (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(receipt())); },
    (_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{}'); },
    (_req, res) => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(receipt())); },
    (_req, res) => goodResponse(res, receipt(), { 'Content-Type': 'text/html' }),
    (_req, res) => goodResponse(res, receipt(), { 'Content-Encoding': 'gzip' }),
    (_req, res) => { res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': '6000' }); res.end('not-json'); },
  ];
  for (const handler of cases) {
    const s = await server(handler);
    try { await denied(redeemEnrollmentOverVerifiedHttps(opts(s.origin))); }
    finally { await s.close(); }
  }
});

test('D12 bounds response body size and rejects invalid JSON/extra fields', async () => {
  for (const response of [
    (_req: unknown, res: import('node:http').ServerResponse) => goodResponse(res, { ...receipt(), role: 'owner' }),
    (_req: unknown, res: import('node:http').ServerResponse) => goodResponse(res, { ...receipt(), agentId: 'invalid-id' }),
    (_req: unknown, res: import('node:http').ServerResponse) => { res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('not valid json'); },
    (_req: unknown, res: import('node:http').ServerResponse) => { res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Transfer-Encoding': 'chunked' }); res.end('x'.repeat(2500)); },
  ]) {
    const s = await server(response);
    try { await denied(redeemEnrollmentOverVerifiedHttps(opts(s.origin))); }
    finally { await s.close(); }
  }
});

test('D12 denies response with different organization or independently expected agent', async () => {
  for (const candidate of [{ ...receipt(), organizationId: '55c52f44-8372-4edc-8346-4d5ace9cfde3' },
    { ...receipt(), agentId: '55c52f44-8372-4edc-8346-4d5ace9cfde3' }]) {
    const s = await server((_req, res) => goodResponse(res, candidate));
    try { await denied(redeemEnrollmentOverVerifiedHttps(opts(s.origin)), candidate.machineCredential); }
    finally { await s.close(); }
  }
});

test('D12 invalid token, agent fields, CA, timeout and identity are rejected before networking', async () => {
  const base = opts('https://127.0.0.1:12345');
  const cases: unknown[] = [
    { ...base, oneTimeToken: 'x'.repeat(43) },
    { ...base, oneTimeToken: 'secret' },
    { ...base, agent: { ...description, ssh: 'yes' } },
    { ...base, expectedOrganizationId: 'fake' },
    { ...base, expectedAgentId: 'fake' },
    { ...base, trustedCaPem: 'no trust' },
    { ...base, timeoutMs: 0 },
    { ...base, timeoutMs: 25000 },
  ];
  for (const item of cases) await denied(redeemEnrollmentOverVerifiedHttps(item as Parameters<typeof redeemEnrollmentOverVerifiedHttps>[0]));
});

test('D12 timeout denies hanging server without leaking one-time token', async () => {
  const s = await server((_req, _res) => { /* deliberately do not send a response */ });
  try {
    const t = token();
    await denied(redeemEnrollmentOverVerifiedHttps({ ...opts(s.origin, t), timeoutMs: 500 }), t);
  } finally { await s.close(); }
});

test('D12 no token or machine credential is logged during success or failure', async () => {
  const t = token();
  const r = receipt();
  const s = await server((_req, res) => goodResponse(res, r));
  const originalLog = console.log;
  const originalError = console.error;
  const seen: string[] = [];
  console.log = (...args: unknown[]) => { seen.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { seen.push(args.join(' ')); };
  try {
    await redeemEnrollmentOverVerifiedHttps(opts(s.origin, t));
    await denied(redeemEnrollmentOverVerifiedHttps(opts('https://bad.example.invalid', t)), t);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await s.close();
  }
  assert.equal(seen.some(x => x.includes(t) || x.includes(r.machineCredential)), false);
});
