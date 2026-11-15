/**
 * Pulse Metrics D15C-5S — actual HTTPS transport to isolated Express candidate.
 * No DB connection, no WorkOS account, no agent credential vault.
 * Uses synthetic secrets and a test-only in-memory receipt adapter.
 * Run ONLY via run-isolated-https-sender-rehearsal.sh, which creates test CA.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { once } from 'node:events';
import express from 'express';

import { LinuxTelemetryCollector } from '../../src/agent/linux-collector.ts';
import { validateTelemetryEnvelope } from '../../src/agent/telemetry-contract.ts';
import {
  createHttpsTelemetrySender,
  PROPOSED_TELEMETRY_PATH,
  TelemetryDeliveryError,
} from '../../src/agent/transport/https-telemetry-sender.ts';
import {
  createIsolatedTelemetryHttpCandidate,
} from '../../src/server/telemetry/http-ingestion.ts';
import {
  createIsolatedTelemetryIngressGuard,
} from '../../src/server/security/telemetry-ingress.ts';
import {
  InvalidMachineCredentialError,
  TelemetryAgentRateLimited,
  TelemetrySubmissionConflict,
} from '../../src/server/telemetry/postgres-ingestion.ts';
import { prepareTelemetrySubmission } from '../../src/server/telemetry/submission-identity.ts';

const fail = (message) => { throw new Error(`D15C-5S refused: ${message}`); };
if (process.platform !== 'linux' || process.env.NODE_ENV !== 'development' ||
    process.env.PULSE_D15C5S_ONLY !== 'YES' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  fail('isolated Linux development-only prerequisites missing');
}
const { PULSE_D15C5S_OK_KEY, PULSE_D15C5S_OK_CERT,
  PULSE_D15C5S_BAD_KEY, PULSE_D15C5S_BAD_CERT,
  PULSE_D15C5S_WRONG_KEY, PULSE_D15C5S_WRONG_CERT } = process.env;
for (const path of [PULSE_D15C5S_OK_KEY,PULSE_D15C5S_OK_CERT,
  PULSE_D15C5S_BAD_KEY,PULSE_D15C5S_BAD_CERT,
  PULSE_D15C5S_WRONG_KEY,PULSE_D15C5S_WRONG_CERT]) {
  if (!path || !path.startsWith('/tmp/pulse-d15c5s-')) fail('test certificate paths missing');
}
if (process.env.NODE_EXTRA_CA_CERTS !== process.env.PULSE_D15C5S_CA) {
  fail('explicit test-only CA must be active');
}

const [goodKey, goodCert, badKey, badCert, wrongKey, wrongCert] =
  await Promise.all([PULSE_D15C5S_OK_KEY,PULSE_D15C5S_OK_CERT,
    PULSE_D15C5S_BAD_KEY,PULSE_D15C5S_BAD_CERT,
    PULSE_D15C5S_WRONG_KEY,PULSE_D15C5S_WRONG_CERT].map(x => readFile(x)));

const servers = [];
async function startHttps(key, cert, app) {
  const server = createServer({ key, cert }, app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  return `https://127.0.0.1:${address.port}`;
}
async function closeAll() {
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
}

const secretA = randomBytes(32).toString('base64url');
const secretB = randomBytes(32).toString('base64url');
const revoked = new Set();
const receipts = new Map();
let forcedRateLimit = false;
let received = 0;
let networkChecks = 0;
let capturedBody = null;
const ingest = async (credential, submissionId, envelope) => {
  received += 1;
  if ((credential !== secretA && credential !== secretB) || revoked.has(credential)) {
    throw new InvalidMachineCredentialError();
  }
  // Uses the actual server-side normalization / fingerprint contract.
  const prepared = prepareTelemetrySubmission(submissionId, envelope);
  const identity = credential === secretA ? 'synthetic-agent-a' : 'synthetic-agent-b';
  const key = `${identity}:${submissionId}`;
  const old = receipts.get(key);
  if (old !== undefined) {
    if (old === prepared.payloadSha256) return 'duplicate';
    throw new TelemetrySubmissionConflict();
  }
  if (forcedRateLimit) throw new TelemetryAgentRateLimited(45);
  receipts.set(key, prepared.payloadSha256);
  return 'inserted';
};

const app = express();
const ingress = createIsolatedTelemetryIngressGuard({
  mode: 'direct-tls',
  checkNetwork: async address => {
    assert.equal(address, '127.0.0.1');
    networkChecks += 1;
  },
  isolatedTestOnly: true,
  production: false,
});
const candidate = createIsolatedTelemetryHttpCandidate({
  ingest,
  isolatedTestOnly: true,
  production: false,
});
app.post(PROPOSED_TELEMETRY_PATH,
  ingress,
  express.json({ limit: '64kb', inflate: false, strict: true }),
  (req,res,next) => {
    // Confirm that no client-selected tenant or agent identity reached the route.
    capturedBody = req.body;
    next();
  },
  candidate.admitIsolatedTestRequest,
  candidate.handler,
);
app.use((_req,res) => res.status(404).end());

const makePayload = (machineCredential, submissionId, envelope) =>
  ({ machineCredential, submissionId, envelope });
const expectFailure = async (fn, code, retry = null) => {
  await assert.rejects(fn, error =>
    error instanceof TelemetryDeliveryError &&
    error.code === code && error.retryAfterSeconds === retry &&
    !error.message.includes(secretA) && !error.message.includes(secretB),
  );
};

try {
  const origin = await startHttps(goodKey, goodCert, app);
  const sender = createHttpsTelemetrySender({
    origin,
    timeoutMs: 5000,
    fetchImpl: globalThis.fetch,
  });
  const envelope = await new LinuxTelemetryCollector().collect();
  assert.equal(validateTelemetryEnvelope(envelope), true);
  assert.ok(envelope.samples.length > 0);
  assert.equal(envelope.samples.some(x => x.metric === 'memory.total_bytes' && x.status === 'measured'), true);

  const id = randomUUID();
  assert.equal(await sender.send(makePayload(secretA,id,envelope)), 'inserted');
  assert.deepEqual(Object.keys(capturedBody).sort(), ['envelope','submissionId']);
  assert.equal(capturedBody.submissionId,id);
  assert.equal(JSON.stringify(capturedBody).includes(secretA),false);
  assert.equal(await sender.send(makePayload(secretA,id,envelope)), 'duplicate');
  console.log('PASS: real Linux telemetry -> verified local HTTPS -> isolated ingress -> 202/200');

  const changed = structuredClone(envelope);
  // Alter the sample timestamp while preserving its canonical format and validity.
  changed.sentAt = new Date(Date.now() + 1000).toISOString();
  await expectFailure(() => sender.send(makePayload(secretA,id,changed)), 'submission_conflict');
  console.log('PASS: same UUID with changed content rejected as HTTP 409');

  assert.equal(await sender.send(makePayload(secretB,id,envelope)), 'inserted');
  assert.equal(receipts.size,2);
  console.log('PASS: fixture agent identities have independent submission namespaces');

  const unknownSecret = randomBytes(32).toString('base64url');
  await expectFailure(() => sender.send(makePayload(unknownSecret,randomUUID(),envelope)), 'credential_rejected');
  forcedRateLimit = true;
  await expectFailure(() => sender.send(makePayload(secretA,randomUUID(),envelope)), 'rate_limited',45);
  forcedRateLimit = false;
  revoked.add(secretA);
  await expectFailure(() => sender.send(makePayload(secretA,id,envelope)), 'credential_rejected');
  console.log('PASS: HTTP 401 unauthorized/revoked; HTTP 429 bounded backoff without automatic retry');

  const before = received;
  await expectFailure(() => sender.send({
    machineCredential: secretB,
    submissionId: randomUUID(),
    envelope,
    organizationId: randomUUID(),
  }), 'invalid_request');
  assert.equal(received,before);
  console.log('PASS: browser/agent-supplied organization selector rejected before HTTP');

  const badApp = express();
  let badVisits = 0;
  badApp.post(PROPOSED_TELEMETRY_PATH,(_req,res) => {badVisits++;res.status(500).end();});
  const badOrigin = await startHttps(badKey,badCert,badApp);
  const badSender = createHttpsTelemetrySender({origin:badOrigin,fetchImpl:globalThis.fetch,timeoutMs:3000});
  await expectFailure(() => badSender.send(makePayload(secretB,randomUUID(),envelope)), 'unavailable');
  assert.equal(badVisits,0);
  console.log('PASS: untrusted TLS server certificate rejected before HTTP');

  const wrongOrigin = await startHttps(wrongKey,wrongCert,badApp);
  const wrongSender = createHttpsTelemetrySender({origin:wrongOrigin,fetchImpl:globalThis.fetch,timeoutMs:3000});
  await expectFailure(() => wrongSender.send(makePayload(secretB,randomUUID(),envelope)), 'unavailable');
  assert.equal(badVisits,0);
  console.log('PASS: trusted CA but wrong certificate hostname rejected before HTTP');

  assert.ok(networkChecks >= 6);
  console.log('PASS: checked direct-TLS ingress; all listeners bound only to 127.0.0.1');
  console.log('========== D15C-5S HTTPS SENDER->INGRESS REHEARSAL: ALL CHECKS PASSED ==========');
  console.log('PUBLIC LAUNCH: NO_GO | synthetic in-memory receipts; PostgreSQL is NOT connected in this test');
} finally {
  await closeAll();
}
