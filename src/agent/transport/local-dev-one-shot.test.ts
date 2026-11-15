/** D15C-5U-1 tests: no actual network listener or PostgreSQL operations. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installMachineCredential } from '../security/credential-vault.js';
import { validateTelemetryEnvelope } from '../telemetry-contract.js';
import { PROPOSED_TELEMETRY_PATH, TelemetryDeliveryError } from './https-telemetry-sender.js';
import { deliverLocalDevelopmentSampleOnce, LocalDevOneShotError } from './local-dev-one-shot.js';

const ORG = '745fe135-cf12-49aa-9a25-bfc3ebd12860';
const AGENT = '5d18f011-dd28-471a-a14a-945fa4bb7774';
const SECRET = randomBytes(32).toString('base64url');
const ORIGIN = 'https://127.0.0.1:43443';
const response = (status: number, body: Record<string, string>) => new Response(
  JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
);

type Fetch = NonNullable<Parameters<typeof deliverLocalDevelopmentSampleOnce>[0]['fetchImpl']>;

async function fixture(run: (dir: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'pulse-d15c5u-'));
  const vault = join(base, 'vault');
  try {
    await installMachineCredential(vault, {
      organizationId: ORG, agentId: AGENT, machineCredential: SECRET,
    }, { organizationId: ORG, agentId: AGENT });
    await run(vault);
  } finally { await rm(base, { recursive: true, force: true }); }
}

const options = (credentialDirectory: string, fetchImpl: Fetch) => ({
  credentialDirectory, expectedOrganizationId: ORG, expectedAgentId: AGENT,
  origin: ORIGIN, fetchImpl,
});

async function rejectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof LocalDevOneShotError && error.code === code &&
    !error.message.includes(SECRET) && !error.message.includes(ORIGIN));
}

const permitted = () => {
  const previous = process.env.PULSE_D15C5U_LOCAL_ONLY;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.PULSE_D15C5U_LOCAL_ONLY = 'YES';
  delete process.env.NODE_ENV;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  return () => {
    if (previous === undefined) delete process.env.PULSE_D15C5U_LOCAL_ONLY;
    else process.env.PULSE_D15C5U_LOCAL_ONLY = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  };
};

test('5U-1 stays disabled without exact local opt-in and in production', async () => {
  if (process.platform !== 'linux') return;
  const restore = permitted();
  try {
    let calls = 0;
    const transport: Fetch = async () => { calls++; return response(202, { status: 'inserted' }); };
    delete process.env.PULSE_D15C5U_LOCAL_ONLY;
    await rejectCode(deliverLocalDevelopmentSampleOnce(options('/no/such/vault', transport)), 'disabled');
    process.env.PULSE_D15C5U_LOCAL_ONLY = 'YES';
    process.env.NODE_ENV = 'production';
    await rejectCode(deliverLocalDevelopmentSampleOnce(options('/no/such/vault', transport)), 'disabled');
    delete process.env.NODE_ENV;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    await rejectCode(deliverLocalDevelopmentSampleOnce(options('/no/such/vault', transport)), 'disabled');
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('5U-1 rejects all non-loopback, unsafe or ambiguous origins before vault access', async () => {
  if (process.platform !== 'linux') return;
  const restore = permitted();
  try {
    const fetchImpl: Fetch = async () => { throw new Error('should not reach network'); };
    for (const origin of [
      'http://127.0.0.1:43443', 'https://localhost:43443',
      'https://0.0.0.0:43443', 'https://192.168.1.116:43443',
      'https://[::1]:43443', 'https://127.0.0.1',
      'https://127.0.0.1:443', 'https://127.0.0.1:43443/',
      'https://127.0.0.1:43443/anything', 'https://127.0.0.1:43443/?x=1',
      'https://name:pass@127.0.0.1:43443',
    ]) {
      await rejectCode(deliverLocalDevelopmentSampleOnce({
        ...options('/no/such/vault', fetchImpl), origin,
      }), 'invalid_configuration');
    }
  } finally { restore(); }
});

test('5U-1 refuses a mismatched independently expected identity without transport', async () => {
  if (process.platform !== 'linux') return;
  const restore = permitted();
  try {
    await fixture(async dir => {
      let calls = 0;
      const fetchImpl: Fetch = async () => { calls++; return response(202, { status: 'inserted' }); };
      await rejectCode(deliverLocalDevelopmentSampleOnce({
        ...options(dir, fetchImpl), expectedAgentId: randomUUID(),
      }), 'identity_mismatch');
      await rejectCode(deliverLocalDevelopmentSampleOnce({
        ...options(dir, fetchImpl), expectedOrganizationId: randomUUID(),
      }), 'identity_mismatch');
      assert.equal(calls, 0);
    });
  } finally { restore(); }
});

test('5U-1 reads protected vault, collects real Linux metrics and sends exactly once', async () => {
  if (process.platform !== 'linux') return;
  const restore = permitted();
  try {
    await fixture(async dir => {
      let calls = 0;
      const fetchImpl: Fetch = async (url, init) => {
        calls++;
        assert.equal(url, ORIGIN + PROPOSED_TELEMETRY_PATH);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'manual');
        assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`);
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body).sort(), ['envelope', 'submissionId']);
        assert.equal(typeof body.submissionId, 'string');
        assert.equal(validateTelemetryEnvelope(body.envelope), true);
        assert.equal(JSON.stringify(body).includes(SECRET), false);
        return response(202, { status: 'inserted' });
      };
      const receipt = await deliverLocalDevelopmentSampleOnce(options(dir, fetchImpl));
      assert.equal(receipt.status, 'inserted');
      assert.match(receipt.submissionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
      assert.ok(receipt.sampleCount > 0);
      assert.deepEqual(Object.keys(receipt).sort(), ['sampleCount', 'status', 'submissionId']);
      assert.equal(calls, 1);
    });
  } finally { restore(); }
});

test('5U-1 propagates sanitized HTTP denial with no automatic retry', async () => {
  if (process.platform !== 'linux') return;
  const restore = permitted();
  try {
    await fixture(async dir => {
      let calls = 0;
      const fetchImpl: Fetch = async () => {
        calls++;
        return response(401, { error: 'invalid_machine_credential' });
      };
      await assert.rejects(deliverLocalDevelopmentSampleOnce(options(dir, fetchImpl)),
        (error: unknown) => error instanceof TelemetryDeliveryError &&
          error.code === 'credential_rejected' && !error.message.includes(SECRET));
      assert.equal(calls, 1);
    });
  } finally { restore(); }
});
