import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import express from 'express';

import {
  createIsolatedTelemetryHttpCandidate,
  type TelemetryHttpIngest,
} from './http-ingestion.js';

import {
  InvalidMachineCredentialError,
  TelemetrySubmissionConflict,
  TelemetryPersistenceUnavailable,
} from './postgres-ingestion.js';

const SECRET = 'A'.repeat(43);
const SUBMISSION_ID =
  '550e8400-e29b-41d4-a716-446655440000';

let server: Server;
let baseUrl = '';
let calls = 0;

type MockOutcome =
  | 'inserted'
  | 'duplicate'
  | 'conflict'
  | 'invalid'
  | 'unavailable';

let outcome: MockOutcome = 'inserted';

function validPayload() {
  const now = new Date().toISOString();

  return {
    submissionId: SUBMISSION_ID,
    envelope: {
      schemaVersion: 1,
      sentAt: now,
      samples: [
        {
          metric: 'cpu.usage_percent',
          value: 24.5,
          unit: 'percent',
          observedAt: now,
          status: 'measured',
        },
      ],
    },
  };
}

const ingest: TelemetryHttpIngest = async (
  secret,
  submissionId,
  envelope,
) => {
  calls++;

  assert.equal(secret, SECRET);
  assert.equal(submissionId, SUBMISSION_ID);

  assert.equal(
    typeof envelope,
    'object',
  );

  assert.ok(envelope !== null);

  const record = envelope as {
    schemaVersion: number;
    samples: Array<{
      metric: string;
      value: number;
    }>;
  };

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.samples.length, 1);
  assert.equal(
    record.samples[0].metric,
    'cpu.usage_percent',
  );
  assert.equal(record.samples[0].value, 24.5);

  switch (outcome) {
    case 'inserted':
      return 'inserted';

    case 'duplicate':
      return 'duplicate';

    case 'conflict':
      throw new TelemetrySubmissionConflict();

    case 'invalid':
      throw new InvalidMachineCredentialError();

    case 'unavailable':
      throw new TelemetryPersistenceUnavailable();
  }
};

before(async () => {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const candidate = createIsolatedTelemetryHttpCandidate({
    ingest,
    isolatedTestOnly: true,
    production: false,
  });

  const productionCandidate =
    createIsolatedTelemetryHttpCandidate({
      ingest,
      isolatedTestOnly: true,
      production: true,
    });

  app.post('/unadmitted', candidate.handler);

  app.post(
    '/isolated-test-only',
    candidate.admitIsolatedTestRequest,
    candidate.handler,
  );

  app.post(
    '/production-disabled',
    productionCandidate.admitIsolatedTestRequest,
    productionCandidate.handler,
  );

  server = createServer(app);

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  assert.ok(
    address &&
    typeof address !== 'string',
  );

  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

async function submit(
  route: string,
  body: unknown = validPayload(),
  authorization: string | null = `Bearer ${SECRET}`,
  contentType = 'application/json',
) {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
  };

  if (authorization !== null) {
    headers.Authorization = authorization;
  }

  return fetch(baseUrl + route, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

test('unadmitted route fails closed', async () => {
  calls = 0;

  const response = await submit('/unadmitted');

  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.equal(
    response.headers.get('cache-control'),
    'no-store',
  );
});

test('production configuration rejects actual HTTP request', async () => {
  calls = 0;

  const response = await submit('/production-disabled');

  assert.equal(response.status, 503);
  assert.equal(calls, 0);

  assert.deepEqual(await response.json(), {
    error: 'telemetry_ingress_unavailable',
  });
});

test('missing machine credential is rejected', async () => {
  calls = 0;

  const response = await submit(
    '/isolated-test-only',
    validPayload(),
    null,
  );

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('malformed machine credential is rejected', async () => {
  calls = 0;

  const response = await submit(
    '/isolated-test-only',
    validPayload(),
    'Bearer short-secret',
  );

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('browser-controlled organization is rejected', async () => {
  calls = 0;

  const response = await submit('/isolated-test-only', {
    ...validPayload(),
    organizationId: SUBMISSION_ID,
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('browser-controlled agent is rejected', async () => {
  calls = 0;

  const response = await submit('/isolated-test-only', {
    ...validPayload(),
    agentId: SUBMISSION_ID,
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('unsupported media type is rejected', async () => {
  calls = 0;

  const response = await submit(
    '/isolated-test-only',
    validPayload(),
    `Bearer ${SECRET}`,
    'text/plain',
  );

  assert.equal(response.status, 415);
  assert.equal(calls, 0);
});

test('missing submission identity is rejected', async () => {
  calls = 0;

  const response = await submit(
    '/isolated-test-only',
    {
      envelope: validPayload().envelope,
    },
  );

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('extra top-level properties are rejected', async () => {
  calls = 0;

  const response = await submit(
    '/isolated-test-only',
    {
      ...validPayload(),
      role: 'admin',
    },
  );

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('real-shaped CPU telemetry reaches injected gateway', async () => {
  calls = 0;
  outcome = 'inserted';

  const response = await submit('/isolated-test-only');

  assert.equal(response.status, 202);
  assert.equal(calls, 1);

  assert.deepEqual(await response.json(), {
    status: 'inserted',
  });
});

test('duplicate acknowledgment is distinct', async () => {
  calls = 0;
  outcome = 'duplicate';

  const response = await submit('/isolated-test-only');

  assert.equal(response.status, 200);
  assert.equal(calls, 1);

  assert.deepEqual(await response.json(), {
    status: 'duplicate',
  });
});

test('submission conflict returns 409', async () => {
  calls = 0;
  outcome = 'conflict';

  const response = await submit('/isolated-test-only');

  assert.equal(response.status, 409);
  assert.equal(calls, 1);

  assert.deepEqual(await response.json(), {
    error: 'telemetry_submission_conflict',
  });
});

test('invalid credential returns generic 401', async () => {
  calls = 0;
  outcome = 'invalid';

  const response = await submit('/isolated-test-only');

  assert.equal(response.status, 401);
  assert.equal(calls, 1);

  assert.deepEqual(await response.json(), {
    error: 'invalid_machine_credential',
  });
});

test('persistence outage returns sanitized 503', async () => {
  calls = 0;
  outcome = 'unavailable';

  const response = await submit('/isolated-test-only');

  assert.equal(response.status, 503);
  assert.equal(calls, 1);

  assert.deepEqual(await response.json(), {
    error: 'telemetry_ingestion_unavailable',
  });
});
