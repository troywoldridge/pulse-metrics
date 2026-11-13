/**
 * Pulse Metrics D15C-4D — real PostgreSQL -> gateway -> HTTP rehearsal.
 *
 * ISOLATED TEST ONLY. Does not provide a production HTTP security boundary.
 * Runs only in an externally verified, marker-bearing disposable PostgreSQL
 * cluster, using the ordinary restricted application role. The test listener
 * binds only to 127.0.0.1 on an ephemeral port. Synthetic identities only.
 *
 * Credential denial is a dedicated protected-function result, never inferred
 * from SQLSTATE 42501; unknown/revoked credentials receive generic HTTP 401.
 * Other SQL permission failures and database outages stay sanitized HTTP 503.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';

import express from 'express';
import pg, { type Pool as PgPool } from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import {
  createPostgresTelemetryIngestionGateway,
} from '../../src/server/telemetry/postgres-ingestion.js';
import {
  createIsolatedTelemetryHttpCandidate,
} from '../../src/server/telemetry/http-ingestion.js';
import {
  MAX_INGESTION_BYTES,
} from '../../src/server/telemetry/normalize-ingestion.js';

const { Pool } = pg;

const socket = process.env.PULSE_D15C4_SOCKET;
const data = process.env.PULSE_D15C4_DATA;
const orgA = process.env.PULSE_D15C4_ORG_A;
const orgB = process.env.PULSE_D15C4_ORG_B;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let stage = 'startup';

function guard(): void {
  assert.equal(process.env.PULSE_D15C4_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.match(socket ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(data, `${dirname(socket!)}/data`);
  const marker = `${dirname(socket!)}/.pulse-telemetry-agent-quota-marker`;
  assert.ok(existsSync(marker));
  const info = lstatSync(marker);
  assert.ok(info.isFile());
  assert.equal(info.isSymbolicLink(), false);
  assert.match(orgA ?? '', UUID);
  assert.match(orgB ?? '', UUID);
  assert.notEqual(orgA, orgB);
}

function makeSecret() {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  return { raw, hash, prefix: hash.slice(0, 12) };
}

function body(value = 42, submissionId = randomUUID()) {
  const time = new Date().toISOString();
  return {
    submissionId,
    envelope: {
      schemaVersion: 1,
      sentAt: time,
      samples: [{
        metric: 'cpu.usage_percent',
        value,
        unit: 'percent',
        observedAt: time,
        status: 'measured',
      }],
    },
  };
}

async function issueAndRedeem(
  pool: PgPool,
  subject: string,
  organizationId: string,
  suffix: string,
) {
  const token = makeSecret();
  const credential = makeSecret();

  const issued = await pool.query(`
    SELECT pulse_agent_enrollment.issue_enrollment(
      $1::text,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz
    ) AS enrollment_id
  `, [
    subject,
    organizationId,
    token.hash,
    token.prefix,
    `D15C4D synthetic ${suffix}`,
    new Date(Date.now() + 600_000).toISOString(),
  ]);
  assert.equal(issued.rows.length, 1);
  assert.match(issued.rows[0]?.enrollment_id ?? '', UUID);

  const redeemed = await pool.query(`
    SELECT * FROM pulse_agent_enrollment.redeem_enrollment(
      $1::text,$2::text,$3::text,$4::text,
      $5::text,$6::text,$7::text
    )
  `, [
    token.hash,
    credential.hash,
    credential.prefix,
    `D15C4D Linux ${suffix}`,
    `d15c4d-${suffix}.invalid`,
    'linux',
    'x86_64',
  ]);
  assert.equal(redeemed.rows.length, 1);
  assert.equal(redeemed.rows[0]?.organization_id, organizationId);
  assert.match(redeemed.rows[0]?.agent_id ?? '', UUID);

  return { credential, agentId: redeemed.rows[0].agent_id as string };
}

interface Received {
  status: number;
  json: Record<string, unknown>;
  retryAfter: string | null;
  cacheControl: string | null;
}

async function main() {
  guard();

  const pool = new Pool({
    host: socket,
    port: 55432,
    user: 'pulse_metrics_app',
    database: 'pulse_metrics',
    ssl: false,
    max: 12,
    connectionTimeoutMillis: 2500,
    statement_timeout: 30_000,
    application_name: 'pulse-d15c4d-http-postgres-synthetic',
  });
  let server: Server | undefined;

  try {
    stage = 'verify restricted database role and Unix socket';
    const who = (await pool.query(`
      SELECT current_database() AS db, current_user AS role,
             inet_server_addr() IS NULL AS socket_only,
             current_setting('port') AS server_port
    `)).rows[0];
    assert.deepEqual(who, {
      db: 'pulse_metrics',
      role: 'pulse_metrics_app',
      socket_only: true,
      server_port: '55432',
    });
    console.log('PASS: restricted PostgreSQL role connected on verified disposable Unix socket');

    stage = 'issue synthetic machine credentials';
    const a = await issueAndRedeem(pool, 'user_agent_owner_a', orgA!, 'http-a');
    const b = await issueAndRedeem(pool, 'user_agent_owner_b', orgB!, 'http-b');
    console.log('PASS: fresh synthetic agents created in two independent organizations');

    const dialect = new PgDialect();
    const gateway = createPostgresTelemetryIngestionGateway(
      async (statement: SQL) => {
        // Always one standalone statement in autocommit mode. Do NOT wrap
        // agent-quota denial in an outer transaction that could roll back it.
        const query = dialect.sqlToQuery(statement);
        return pool.query(query.sql, query.params);
      },
    );

    const app = express();
    app.disable('x-powered-by');
    const candidate = createIsolatedTelemetryHttpCandidate({
      ingest: (secret, id, envelope) => gateway.ingest(secret, id, envelope),
      isolatedTestOnly: true,
      production: false,
    });
    app.post('/isolated-telemetry',
      candidate.admitIsolatedTestRequest,
      express.json({ limit: MAX_INGESTION_BYTES, strict: true, inflate: false }),
      candidate.handler,
    );
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server!.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/isolated-telemetry`;

    const post = async (
      credential: string,
      payload: unknown,
    ): Promise<Received> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(50_000),
      });
      const raw = await response.text();
      // Never echo raw secrets, hashes, SQL or server diagnostics over HTTP.
      assert.equal(raw.includes(credential), false);
      assert.equal(raw.includes('pulse_telemetry_ingestion.'), false);
      assert.equal(raw.includes('postgres:'), false);
      return {
        status: response.status,
        json: JSON.parse(raw) as Record<string, unknown>,
        retryAfter: response.headers.get('retry-after'),
        cacheControl: response.headers.get('cache-control'),
      };
    };

    stage = 'database insert and idempotent HTTP duplicate';
    const first = body(42);
    const inserted = await post(a.credential.raw, first);
    assert.equal(inserted.status, 202);
    assert.deepEqual(inserted.json, { status: 'inserted' });
    assert.equal(inserted.cacheControl, 'no-store');
    const duplicate = await post(a.credential.raw, first);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.json, { status: 'duplicate' });
    console.log('PASS: real PostgreSQL inserted -> HTTP 202, exact duplicate -> HTTP 200');

    stage = 'conflicting submission ID and durable charge';
    const changed = {
      ...first,
      envelope: {
        ...first.envelope,
        samples: [{ ...first.envelope.samples[0], value: 43 }],
      },
    };
    const conflict = await post(a.credential.raw, changed);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.json, { error: 'telemetry_submission_conflict' });
    console.log('PASS: real PostgreSQL conflicting ID -> HTTP 409');

    stage = 'restricted-role credential rejection mapping';
    const unknown = makeSecret();
    const unauthorized = await post(unknown.raw, body(30));
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(unauthorized.json, { error: 'invalid_machine_credential' });
    // An explicit function result maps to 401. SQLSTATE 42501 alone must not.
    console.log('PASS: unknown credential denied with explicit HTTP 401; no SQL leak');

    stage = 'HTTP concurrent authenticated quota exhaustion';
    // First insert + conflict already consume TWO charges in this agent window.
    // 122 new attempts -> exactly 118 more inserts and four 429 denials.
    const attempts = Array.from({ length: 122 }, (_, i) => body((i % 75) + 10));
    const responses = await Promise.all(attempts.map(item => post(a.credential.raw, item)));
    const successes = responses.filter(value => value.status === 202);
    const rejected = responses.filter(value => value.status === 429);
    assert.equal(successes.length, 118);
    assert.equal(rejected.length, 4);
    assert.equal(successes.length + rejected.length, responses.length);
    for (const denial of rejected) {
      assert.deepEqual(denial.json, { error: 'telemetry_rate_limited' });
      assert.match(denial.retryAfter ?? '', /^(?:[1-9]|[1-5][0-9]|60)$/);
      assert.equal(denial.cacheControl, 'no-store');
    }
    console.log('PASS: 122 real HTTP requests -> 118 persisted, 4 rate limited, bounded Retry-After');

    stage = 'post-exhaustion duplicate idempotency';
    const retried = await post(a.credential.raw, first);
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.json, { status: 'duplicate' });
    const blocked = await post(a.credential.raw, body(88));
    assert.equal(blocked.status, 429);
    console.log('PASS: exact duplicate still HTTP 200 after quota exhausted; new submission HTTP 429');

    stage = 'independent tenant and agent quota';
    const otherTenant = await post(b.credential.raw, first);
    assert.equal(otherTenant.status, 202);
    assert.deepEqual(otherTenant.json, { status: 'inserted' });
    console.log('PASS: second tenant independently accepts same submission identity');

    stage = 'revocation invalidates even previously valid replay';
    const revoked = (await pool.query(`
      SELECT pulse_agent_enrollment.revoke_agent(
        $1::text,$2::uuid,$3::uuid
      ) AS revoked
    `, [ 'user_agent_owner_a', orgA, a.agentId ])).rows[0]?.revoked;
    assert.equal(revoked, true);
    const afterRevocation = await post(a.credential.raw, first);
    assert.equal(afterRevocation.status, 401);
    assert.deepEqual(afterRevocation.json, { error: 'invalid_machine_credential' });
    console.log('PASS: revoked credential cannot replay via HTTP; HTTP 401');

    stage = 'unadmitted HTTP path unavailable';
    const unmapped = await fetch(`http://127.0.0.1:${address.port}/isolated-telemetry`, {
      method: 'GET',
    });
    assert.equal(unmapped.status, 404);
    console.log('PASS: no production telemetry route created by rehearsal');

    console.log('D15C-4D REAL POSTGRESQL -> GATEWAY -> HTTP REHEARSAL PASSED');
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close(error => error ? reject(error) : resolve());
      });
    }
    await pool.end();
  }
}

main().catch(error => {
  // Never print SQL parameters, credentials, or driver messages.
  console.error('REFUSE_D15C4D_INTEGRATION: stage=' + stage);
  console.error('ERROR CATEGORY:',
    typeof error?.code === 'string' ? error.code : error?.name ?? 'unknown');
  if (error?.name === 'AssertionError') {
    console.error('ASSERTION:', error.message);
  }
  process.exitCode = 1;
});
