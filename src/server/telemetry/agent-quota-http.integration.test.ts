/**
 * D15C-4C unmounted, isolated HTTP -> PostgreSQL gateway outcome contract.
 *
 * This test uses a synthetic SQL executor, NOT a real database.
 * Real authenticated quota concurrency was independently rehearsed in
 * D15C-4B using disposable PostgreSQL.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';

import express from 'express';
import type { SQL } from 'drizzle-orm';

import {
  createIsolatedTelemetryHttpCandidate,
} from './http-ingestion.js';

import {
  createPostgresTelemetryIngestionGateway,
  TelemetryAgentRateLimited,
  TelemetryPersistenceUnavailable,
} from './postgres-ingestion.js';

const SECRET = randomBytes(32).toString('base64url');
const ID = randomUUID();

let server: Server;
let base = '';
let calls = 0;
let outcome: unknown = 'inserted';
let failing = false;

function payload() {
  const now = new Date().toISOString();
  return {
    submissionId: ID,
    envelope: {
      schemaVersion: 1,
      sentAt: now,
      samples: [{
        metric: 'cpu.usage_percent',
        unit: 'percent',
        value: 35,
        observedAt: now,
        status: 'measured',
      }],
    },
  };
}

const execute = async (_statement: SQL): Promise<unknown> => {
  calls++;
  if (failing) throw new Error('PRIVATE_DATABASE_PASSWORD');
  return { rows: [{ outcome }] };
};

before(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb', strict: true }));

  const gateway = createPostgresTelemetryIngestionGateway(execute);
  const candidate = createIsolatedTelemetryHttpCandidate({
    ingest: (secret, submissionId, envelope) =>
      gateway.ingest(secret, submissionId, envelope),
    isolatedTestOnly: true,
    production: false,
  });
  const disabled = createIsolatedTelemetryHttpCandidate({
    ingest: (secret, submissionId, envelope) =>
      gateway.ingest(secret, submissionId, envelope),
    isolatedTestOnly: true,
    production: true,
  });

  app.post('/unadmitted', candidate.handler);
  app.post('/test', candidate.admitIsolatedTestRequest, candidate.handler);
  app.post('/production-disabled', disabled.admitIsolatedTestRequest, disabled.handler);

  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close(error => {
    if (error) reject(error);
    else resolve();
  }));
});

async function send(path = '/test') {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload()),
  });
}

test('D15C-4C valid database quota denial becomes HTTP 429', async () => {
  failing = false;
  outcome = 'rate_limited:45';
  calls = 0;
  const response = await send();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '45');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), { error: 'telemetry_rate_limited' });
});

test('D15C-4C smallest and largest retry durations are bounded', async () => {
  failing = false;
  for (const retry of [1, 900]) {
    outcome = `rate_limited:${retry}`;
    const response = await send();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), String(retry));
  }
});

test('D15C-4C malformed quota strings never authorize an HTTP request', async () => {
  failing = false;
  for (const bad of ['rate_limited:0', 'rate_limited:901', 'rate_limited:01', 'rate_limited:45\n']) {
    outcome = bad;
    const response = await send();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), null);
    assert.deepEqual(await response.json(), { error: 'telemetry_ingestion_unavailable' });
  }
});

test('D15C-4C legacy successful insertion remains 202', async () => {
  failing = false;
  outcome = 'inserted';
  const response = await send();
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'inserted' });
});

test('D15C-4C authenticated exact duplicate remains 200', async () => {
  failing = false;
  outcome = 'duplicate';
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'duplicate' });
});

test('D15C-4C submission conflict remains HTTP 409', async () => {
  failing = false;
  outcome = 'conflict';
  const response = await send();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'telemetry_submission_conflict' });
});

test('D15C-4C SQL outage fails closed without disclosing secrets', async () => {
  failing = true;
  const response = await send();
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.equal(text.includes('PRIVATE_DATABASE_PASSWORD'), false);
  assert.equal(text.includes(SECRET), false);
  assert.deepEqual(JSON.parse(text), { error: 'telemetry_ingestion_unavailable' });
  failing = false;
});

test('D15C-4C unadmitted and production-disabled routes stay unavailable', async () => {
  failing = false;
  calls = 0;
  const unadmitted = await send('/unadmitted');
  assert.equal(unadmitted.status, 503);
  const production = await send('/production-disabled');
  assert.equal(production.status, 503);
  assert.equal(calls, 0);
});

test('D15C-4C gateway emits typed rate-limit error, not a success', async () => {
  const gateway = createPostgresTelemetryIngestionGateway(
    async () => ({ rows: [{ outcome: 'rate_limited:60' }] }),
  );
  await assert.rejects(
    gateway.ingest(SECRET, randomUUID(), payload().envelope),
    error => {
      assert.ok(error instanceof TelemetryAgentRateLimited);
      assert.equal(error.retryAfterSeconds, 60);
      return true;
    },
  );
});

test('D15C-4C malformed PostgreSQL row is a sanitized outage', async () => {
  for (const row of [
    { outcome: 'rate_limited:60', organization_id: randomUUID() },
    { outcome: 'rate_limited:0' },
    { outcome: 'rate_limited:901' },
  ]) {
    const gateway = createPostgresTelemetryIngestionGateway(
      async () => ({ rows: [row] }),
    );
    await assert.rejects(
      gateway.ingest(SECRET, randomUUID(), payload().envelope),
      TelemetryPersistenceUnavailable,
    );
  }
});
