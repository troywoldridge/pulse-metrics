import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import {
  createPostgresTelemetryIngestionGateway,
  InvalidMachineCredentialError,
  TelemetryPersistenceUnavailable,
  TelemetrySubmissionConflict,
} from './postgres-ingestion.js';

import {
  InvalidSubmissionIdentityError,
} from './submission-identity.js';

import {
  InvalidTelemetryError,
} from './normalize-ingestion.js';

const NOW = Date.parse('2026-11-12T20:00:00.000Z');
const TIME = new Date(NOW).toISOString();

const SECRET = randomBytes(32).toString('base64url');

function envelope(value = 42) {
  return {
    schemaVersion: 1,
    sentAt: TIME,
    samples: [
      {
        metric: 'cpu.usage_percent',
        value,
        unit: 'percent',
        observedAt: TIME,
        status: 'measured',
      },
    ],
  };
}

function executor(outcome: string) {
  let calls = 0;
  let statement: SQL | null = null;

  return {
    execute: async (sqlStatement: SQL) => {
      calls++;
      statement = sqlStatement;
      return { rows: [{ outcome }] };
    },
    get calls() {
      return calls;
    },
    get statement() {
      return statement;
    },
  };
}

test('requires explicit database executor', () => {
  assert.throws(
    () => createPostgresTelemetryIngestionGateway(
      null as never,
    ),
    TypeError,
  );
});

test('accepts successful insert result', async () => {
  const db = executor('inserted');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  const result = await gateway.ingest(
    SECRET,
    randomUUID(),
    envelope(),
    NOW,
  );

  assert.equal(result, 'inserted');
  assert.equal(db.calls, 1);
});

test('accepts a verified duplicate acknowledgment', async () => {
  const db = executor('duplicate');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  const result = await gateway.ingest(
    SECRET,
    randomUUID(),
    envelope(),
    NOW,
  );

  assert.equal(result, 'duplicate');
});

test('rejects database-reported submission conflicts', async () => {
  const db = executor('conflict');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  await assert.rejects(
    gateway.ingest(SECRET, randomUUID(), envelope(), NOW),
    TelemetrySubmissionConflict,
  );
});

test('rejects unknown or malformed database outcomes', async () => {
  for (const result of [
    { rows: [] },
    { rows: [{ outcome: 'inserted' }, { outcome: 'inserted' }] },
    { rows: [{ outcome: 'authorized' }] },
    { rows: [{ outcome: true }] },
    { rows: [{}] },
    { rows: null },
    null,
  ]) {
    const gateway = createPostgresTelemetryIngestionGateway(
      async () => result,
    );

    await assert.rejects(
      gateway.ingest(SECRET, randomUUID(), envelope(), NOW),
      TelemetryPersistenceUnavailable,
    );
  }
});

test('refuses invalid secrets before database access', async () => {
  const db = executor('inserted');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  for (const secret of [
    null,
    '',
    'not-a-machine-credential',
    'a'.repeat(43),
  ]) {
    await assert.rejects(
      gateway.ingest(secret, randomUUID(), envelope(), NOW),
      InvalidMachineCredentialError,
    );
  }

  assert.equal(db.calls, 0);
});

test('refuses invalid submission IDs before database access', async () => {
  const db = executor('inserted');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  await assert.rejects(
    gateway.ingest(SECRET, 'retry-1', envelope(), NOW),
    InvalidSubmissionIdentityError,
  );

  assert.equal(db.calls, 0);
});

test('refuses invalid telemetry before database access', async () => {
  const db = executor('inserted');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  await assert.rejects(
    gateway.ingest(SECRET, randomUUID(), envelope(101), NOW),
    InvalidTelemetryError,
  );

  assert.equal(db.calls, 0);
});

test('uses credential digest and parameterized SQL, never raw secret', async () => {
  const db = executor('inserted');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  const id = randomUUID();

  await gateway.ingest(SECRET, id, envelope(), NOW);

  assert.ok(db.statement);

  const query = new PgDialect().sqlToQuery(db.statement);

  const expectedHash = createHash('sha256')
    .update(SECRET, 'utf8')
    .digest('hex');

  // Verify exact parameter values, not just successful execution.
  assert.equal(query.params[0], expectedHash);
  assert.equal(query.params[1], id);
  assert.equal(query.params[3], TIME);
  assert.equal(query.params[4], 1);
  assert.equal(query.params[5], 42);

  // Never send the raw machine credential to PostgreSQL.
  assert.equal(query.params.includes(SECRET), false);

  // The digest and submission ID must remain bound parameters.
  assert.equal(query.params.includes(expectedHash), true);
  assert.equal(query.params.includes(id), true);

  // Drizzle PgDialect returns SQL text in .sql, not .text.
  assert.equal(typeof query.sql, 'string');

  assert.equal(query.sql.includes(SECRET), false);
  assert.equal(query.sql.includes(expectedHash), false);
  assert.equal(query.sql.includes(id), false);

  // Verify the intended dedicated database operation is called.
  assert.match(
    query.sql,
    /pulse_telemetry_ingestion\.ingest_submission/,
  );

  // Confirm SQL placeholders remain in the generated statement.
  assert.match(query.sql, /\$1\b/);
  assert.match(query.sql, /\$2\b/);
});

test('does not send client-controlled organization or agent IDs', async () => {
  const db = executor('inserted');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  await assert.rejects(
    gateway.ingest(SECRET, randomUUID(), {
      ...envelope(),
      organizationId: randomUUID(),
      agentId: randomUUID(),
    }, NOW),
    InvalidTelemetryError,
  );

  assert.equal(db.calls, 0);
});

test('database errors are sanitized', async () => {
  const gateway = createPostgresTelemetryIngestionGateway(
    async () => {
      throw new Error(
        'sensitive database URL and private credential details',
      );
    },
  );

  await assert.rejects(
    gateway.ingest(SECRET, randomUUID(), envelope(), NOW),
    (error: unknown) => {
      assert.ok(error instanceof TelemetryPersistenceUnavailable);
      assert.equal(
        error.message.includes('sensitive'),
        false,
      );
      return true;
    },
  );
});

test('duplicate identity is stable for retries', async () => {
  const db = executor('duplicate');
  const gateway = createPostgresTelemetryIngestionGateway(
    db.execute,
  );

  const id = randomUUID();

  assert.equal(
    await gateway.ingest(SECRET, id, envelope(), NOW),
    'duplicate',
  );

  assert.equal(
    await gateway.ingest(SECRET, id, envelope(), NOW + 1000),
    'duplicate',
  );

  assert.equal(db.calls, 2);
});
