import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { SQL } from 'drizzle-orm';
import { createPostgresTelemetryIngestionGateway,
  InvalidMachineCredentialError, TelemetryPersistenceUnavailable,
} from './postgres-ingestion.js';
import { createIsolatedTelemetryHttpCandidate } from './http-ingestion.js';

const SECRET = randomBytes(32).toString('base64url');
const TIME = '2026-11-13T12:00:00.000Z';
function envelope() {
  return { schemaVersion: 1, sentAt: TIME,
    samples: [{ metric: 'cpu.usage_percent', value: 42, unit: 'percent',
      observedAt: TIME, status: 'measured' }] };
}
const submit = async (execute: (sql: SQL)=>Promise<unknown>) =>
  createPostgresTelemetryIngestionGateway(execute)
    .ingest(SECRET, randomUUID(), envelope(), Date.parse(TIME));

test('D15C-4E explicit credential rejection maps to typed authentication failure', async () => {
  await assert.rejects(submit(async () => ({rows:[{outcome:'credential_unavailable'}]})),
    InvalidMachineCredentialError);
});

test('D15C-4E raw SQLSTATE 42501 remains a sanitized outage, never 401', async () => {
  await assert.rejects(submit(async () => { const err = new Error('PRIVATE ACL');
    Object.assign(err, {code:'42501'}); throw err; }),
    error => error instanceof TelemetryPersistenceUnavailable &&
      !error.message.includes('PRIVATE'));
});

test('D15C-4E malformed result and error text never authorize ingestion', async () => {
  for (const outcome of ['credential_unavailable ', '42501', 'unknown', null]) {
    await assert.rejects(submit(async () => ({rows:[{outcome}]})),
      TelemetryPersistenceUnavailable);
  }
});

test('D15C-4E HTTP uses 401 only for explicit protected-function result', async () => {
  let mode: 'unauthorized' | 'db_error' = 'unauthorized';
  const app = express();
  app.use(express.json({limit:'64kb'}));
  const gateway = createPostgresTelemetryIngestionGateway(async () => {
    if (mode === 'db_error') {
      const err = new Error('PRIVATE SQLSTATE');
      Object.assign(err, {code:'42501'});
      throw err;
    }
    return {rows:[{outcome:'credential_unavailable'}]};
  });
  const candidate = createIsolatedTelemetryHttpCandidate({
    ingest: (secret,id,env) => gateway.ingest(secret,id,env),
    isolatedTestOnly: true, production: false,
  });
  app.post('/isolated-only', candidate.admitIsolatedTestRequest, candidate.handler);
  let server: Server | undefined;
  try {
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const url=`http://127.0.0.1:${addr.port}/isolated-only`;
    const post = () => fetch(url, {method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${SECRET}`},
      body:JSON.stringify({submissionId:randomUUID(), envelope:{
        schemaVersion:1,sentAt:new Date().toISOString(),samples:[{
          metric:'cpu.usage_percent',value:42,unit:'percent',
          status:'measured',observedAt:new Date().toISOString(),
        }],
      }})});
    const invalid=await post();
    assert.equal(invalid.status,401);
    assert.deepEqual(await invalid.json(),{error:'invalid_machine_credential'});
    assert.equal(invalid.headers.get('cache-control'),'no-store');
    mode='db_error';
    const unavailable=await post();
    assert.equal(unavailable.status,503);
    assert.deepEqual(await unavailable.json(),{error:'telemetry_ingestion_unavailable'});
  } finally {
    if (server) await new Promise<void>((resolve,reject) =>
      server!.close(e => e ? reject(e) : resolve()));
  }
});
