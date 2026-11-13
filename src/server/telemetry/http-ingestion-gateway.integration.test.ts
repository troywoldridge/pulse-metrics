import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import express from 'express';
import type { SQL } from 'drizzle-orm';

import {
  createIsolatedTelemetryHttpCandidate,
} from './http-ingestion.js';

import {
  createPostgresTelemetryIngestionGateway,
} from './postgres-ingestion.js';

const SECRET = 'A'.repeat(43);

const SUBMISSION_ID =
  '550e8400-e29b-41d4-a716-446655440000';

type DatabaseOutcome =
  | 'inserted'
  | 'duplicate'
  | 'conflict'
  | 'unexpected'
  | 'failure';

let server: Server;
let baseUrl = '';
let databaseCalls = 0;
let databaseOutcome: DatabaseOutcome = 'inserted';

function validPayload() {
  const timestamp = new Date().toISOString();

  return {
    submissionId: SUBMISSION_ID,
    envelope: {
      schemaVersion: 1,
      sentAt: timestamp,
      samples: [
        {
          metric: 'cpu.usage_percent',
          value: 24.5,
          unit: 'percent',
          observedAt: timestamp,
          status: 'measured',
        },
      ],
    },
  };
}

// This function is a synthetic SQL executor.
// It does not open a database connection.
async function executeSyntheticSql(
  _statement: SQL,
): Promise<unknown> {
  databaseCalls++;

  if (databaseOutcome === 'failure') {
    throw new Error('PRIVATE_SYNTHETIC_DATABASE_ERROR');
  }

  if (databaseOutcome === 'unexpected') {
    return {
      rows: [{ outcome: 'unexpected_result' }],
    };
  }

  return {
    rows: [{ outcome: databaseOutcome }],
  };
}

before(async () => {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const gateway =
    createPostgresTelemetryIngestionGateway(
      executeSyntheticSql,
    );

  const candidate =
    createIsolatedTelemetryHttpCandidate({
      ingest: (
        secret,
        submissionId,
        envelope,
      ) => gateway.ingest(
        secret,
        submissionId,
        envelope,
      ),
      isolatedTestOnly: true,
      production: false,
    });

  app.post(
    '/isolated-integration',
    candidate.admitIsolatedTestRequest,
    candidate.handler,
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

async function send(
  payload: unknown,
  secret: string = SECRET,
) {
  return fetch(
    `${baseUrl}/isolated-integration`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

test('valid CPU telemetry reaches real gateway validation', async () => {
  databaseCalls = 0;
  databaseOutcome = 'inserted';

  const response = await send(validPayload());

  assert.equal(response.status, 202);
  assert.equal(databaseCalls, 1);

  assert.deepEqual(await response.json(), {
    status: 'inserted',
  });
});

test('CPU measurement above 100 is rejected before SQL', async () => {
  databaseCalls = 0;

  const payload = validPayload();
  payload.envelope.samples[0].value = 120;

  const response = await send(payload);

  assert.equal(response.status, 400);
  assert.equal(databaseCalls, 0);
});

test('empty telemetry samples are rejected before SQL', async () => {
  databaseCalls = 0;

  const payload = {
    ...validPayload(),
    envelope: {
      ...validPayload().envelope,
      samples: [],
    },
  };

  const response = await send(payload);

  assert.equal(response.status, 400);
  assert.equal(databaseCalls, 0);
});

test('invalid submission identity is rejected before SQL', async () => {
  databaseCalls = 0;

  const response = await send({
    ...validPayload(),
    submissionId: 'not-a-uuid',
  });

  assert.equal(response.status, 400);
  assert.equal(databaseCalls, 0);
});

test('noncanonical machine credential is rejected before SQL', async () => {
  databaseCalls = 0;

  const response = await send(
    validPayload(),
    'A'.repeat(42) + 'B',
  );

  assert.equal(response.status, 401);
  assert.equal(databaseCalls, 0);
});

test('database duplicate outcome produces HTTP 200', async () => {
  databaseCalls = 0;
  databaseOutcome = 'duplicate';

  const response = await send(validPayload());

  assert.equal(response.status, 200);
  assert.equal(databaseCalls, 1);

  assert.deepEqual(await response.json(), {
    status: 'duplicate',
  });
});

test('database conflict outcome produces HTTP 409', async () => {
  databaseCalls = 0;
  databaseOutcome = 'conflict';

  const response = await send(validPayload());

  assert.equal(response.status, 409);
  assert.equal(databaseCalls, 1);

  assert.deepEqual(await response.json(), {
    error: 'telemetry_submission_conflict',
  });
});

test('unexpected database outcome fails closed', async () => {
  databaseCalls = 0;
  databaseOutcome = 'unexpected';

  const response = await send(validPayload());

  assert.equal(response.status, 503);
  assert.equal(databaseCalls, 1);

  assert.deepEqual(await response.json(), {
    error: 'telemetry_ingestion_unavailable',
  });
});

test('database exceptions do not leak private diagnostics', async () => {
  databaseCalls = 0;
  databaseOutcome = 'failure';

  const response = await send(validPayload());
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.equal(databaseCalls, 1);

  assert.equal(
    text.includes('PRIVATE_SYNTHETIC_DATABASE_ERROR'),
    false,
  );

  assert.equal(text.includes(SECRET), false);

  assert.deepEqual(JSON.parse(text), {
    error: 'telemetry_ingestion_unavailable',
  });
});
