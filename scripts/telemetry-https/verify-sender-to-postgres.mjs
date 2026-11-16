/**
 * Pulse Metrics — D15C-5T isolated end-to-end integration.
 * Genuine Linux collector -> verified HTTPS sender -> direct-TLS ingress
 * -> authenticated restricted-role PostgreSQL gateway -> durable telemetry.
 *
 * Not a production server or agent runner. Only run from the pinned disposable
 * database rehearsal, after all existing 4E quota/permission assertions pass.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { dirname } from 'node:path';

import express from 'express';
import pg from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';

import { LinuxTelemetryCollector } from '../../src/agent/linux-collector.ts';
import { validateTelemetryEnvelope } from '../../src/agent/telemetry-contract.ts';
import {
  createHttpsTelemetrySender,
  PROPOSED_TELEMETRY_PATH,
  TelemetryDeliveryError,
} from '../../src/agent/transport/https-telemetry-sender.ts';
import {
  createIsolatedTelemetryIngressGuard,
  TelemetryIngressRateLimited,
} from '../../src/server/security/telemetry-ingress.ts';
import {
  createIsolatedTelemetryHttpCandidate,
} from '../../src/server/telemetry/http-ingestion.ts';
import {
  createPostgresTelemetryIngestionGateway,
} from '../../src/server/telemetry/postgres-ingestion.ts';
import { MAX_INGESTION_BYTES } from '../../src/server/telemetry/normalize-ingestion.ts';
import { readDisposableTenantHistory } from './disposable-tenant-history.mjs';

const { Pool } = pg;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let stage = 'initial admission';
const {
  PULSE_D15C4_SOCKET: socket,
  PULSE_D15C4_DATA: data,
  PULSE_D15C4_ORG_A: orgA,
  PULSE_D15C4_ORG_B: orgB,
  PULSE_D15C5T_CA: caPath,
  PULSE_D15C5T_TLS_KEY: keyPath,
  PULSE_D15C5T_TLS_CERT: certPath,
} = process.env;

function guard() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.NODE_ENV, 'development');
  assert.equal(process.env.PULSE_D15C5T_ONLY, 'YES');
  assert.equal(process.env.PULSE_D15C4_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  assert.equal(process.env.NODE_EXTRA_CA_CERTS, caPath);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.match(socket ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(data, `${dirname(socket)}/data`);
  const marker = `${dirname(socket)}/.pulse-telemetry-agent-quota-marker`;
  assert.equal(existsSync(marker), true);
  const metadata = lstatSync(marker);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.match(orgA ?? '', UUID);
  assert.match(orgB ?? '', UUID);
  assert.notEqual(orgA, orgB);
  for (const file of [caPath, keyPath, certPath]) {
    assert.match(file ?? '', /^\/tmp\/pulse-d15c5t-[A-Za-z0-9]{6}\/(?:ca\.pem|tls\.key|tls\.pem)$/);
    assert.equal(lstatSync(file).isFile(), true);
  }
}

function makeCredential() {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  return { raw, hash, prefix: hash.slice(0, 12) };
}

async function issueAndRedeem(pool, subject, organizationId, suffix) {
  const oneTimeToken = makeCredential();
  const credential = makeCredential();
  const issue = await pool.query(`
    SELECT pulse_agent_enrollment.issue_enrollment(
      $1::text,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz
    ) AS enrollment_id
  `, [
    subject,
    organizationId,
    oneTimeToken.hash,
    oneTimeToken.prefix,
    `D15C5T synthetic ${suffix}`,
    new Date(Date.now() + 600_000).toISOString(),
  ]);
  assert.equal(issue.rows.length, 1);
  assert.match(issue.rows[0]?.enrollment_id ?? '', UUID);
  const redeem = await pool.query(`
    SELECT * FROM pulse_agent_enrollment.redeem_enrollment(
      $1::text,$2::text,$3::text,$4::text,
      $5::text,$6::text,$7::text
    )
  `, [
    oneTimeToken.hash,
    credential.hash,
    credential.prefix,
    `D15C5T Linux ${suffix}`,
    `d15c5t-${suffix}.invalid`,
    'linux',
    'x86_64',
  ]);
  assert.equal(redeem.rows.length, 1);
  assert.equal(redeem.rows[0]?.organization_id, organizationId);
  assert.match(redeem.rows[0]?.agent_id ?? '', UUID);
  return { credential, agentId: redeem.rows[0].agent_id };
}

async function expectDeliveryError(run, code, retryAfterSeconds = null) {
  await assert.rejects(run, error =>
    error instanceof TelemetryDeliveryError &&
    error.code === code &&
    error.retryAfterSeconds === retryAfterSeconds,
  );
}

async function main() {
  guard();
  const pool = new Pool({
    host: socket,
    port: 55432,
    user: 'pulse_metrics_app',
    database: 'pulse_metrics',
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 2500,
    statement_timeout: 30_000,
    application_name: 'pulse-d15c5t-verified-https-disposable',
  });
  let server;
  try {
    stage = 'restricted PostgreSQL socket connection';
    const who = (await pool.query(`
      SELECT current_database() AS db, current_user AS role,
        inet_server_addr() IS NULL AS socket_only,
        current_setting('port') AS server_port
    `)).rows[0];
    assert.deepEqual(who, {
      db: 'pulse_metrics', role: 'pulse_metrics_app',
      socket_only: true, server_port: '55432',
    });
    console.log('PASS: verified disposable PostgreSQL Unix socket, restricted runtime role');

    stage = 'synthetic credentials issued through protected database functions';
    const a = await issueAndRedeem(pool, 'user_agent_owner_a', orgA, 'a');
    const b = await issueAndRedeem(pool, 'user_agent_owner_b', orgB, 'b');
    console.log('PASS: two independently bound synthetic agents enrolled via PostgreSQL functions');

    const dialect = new PgDialect();
    const gateway = createPostgresTelemetryIngestionGateway(async statement => {
      // One standalone autocommit statement. Denied quota attempts must not
      // be rolled back by an external transaction wrapper.
      const query = dialect.sqlToQuery(statement);
      return pool.query(query.sql, query.params);
    });
    let forcedNetworkRateLimit = false;
    let admitted = 0;
    let capturedBody = null;
    const app = express();
    app.disable('x-powered-by');
    const ingress = createIsolatedTelemetryIngressGuard({
      mode: 'direct-tls',
      isolatedTestOnly: true,
      production: false,
      checkNetwork: async address => {
        assert.equal(address, '127.0.0.1');
        if (forcedNetworkRateLimit) throw new TelemetryIngressRateLimited(45);
        admitted += 1;
      },
    });
    const candidate = createIsolatedTelemetryHttpCandidate({
      ingest: (secret, submissionId, envelope) => gateway.ingest(secret, submissionId, envelope),
      isolatedTestOnly: true,
      production: false,
    });
    app.post(PROPOSED_TELEMETRY_PATH,
      ingress,
      express.json({ limit: MAX_INGESTION_BYTES, strict: true, inflate: false }),
      (req, _res, next) => { capturedBody = req.body; next(); },
      candidate.admitIsolatedTestRequest,
      candidate.handler,
    );
    app.use((_req, res) => res.status(404).end());
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    server = createServer({ key, cert }, app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    const origin = `https://127.0.0.1:${address.port}`;
    const sender = createHttpsTelemetrySender({ origin, timeoutMs: 10000, fetchImpl: globalThis.fetch });

    stage = 'genuine Linux sample over verified HTTPS to real PostgreSQL';
    const envelope = await new LinuxTelemetryCollector().collect();
    assert.equal(validateTelemetryEnvelope(envelope), true);
    assert.ok(envelope.samples.length > 0);
    assert.ok(envelope.samples.some(x => x.metric === 'memory.total_bytes' && x.status === 'measured'));
    const submissionId = randomUUID();
    const submission = { machineCredential: a.credential.raw, submissionId, envelope };
    assert.equal(await sender.send(submission), 'inserted');
    assert.deepEqual(Object.keys(capturedBody).sort(), ['envelope', 'submissionId']);
    assert.equal(capturedBody.submissionId, submissionId);
    assert.equal(JSON.stringify(capturedBody).includes(a.credential.raw), false);
    assert.equal(await sender.send(submission), 'duplicate');
    console.log('PASS: genuine Linux metrics -> verified HTTPS -> restricted PostgreSQL -> 202/200');

    stage = 'fingerprint conflict through genuine database gateway';
    const changed = structuredClone(envelope);
    changed.sentAt = new Date(Date.parse(envelope.sentAt) + 1000).toISOString();
    await expectDeliveryError(() => sender.send({ ...submission, envelope: changed }), 'submission_conflict');
    console.log('PASS: altered retry content under same submission UUID rejected with HTTP 409');

    stage = 'cross-tenant independent receipt and authorization';
    assert.equal(await sender.send({ machineCredential: b.credential.raw, submissionId, envelope }), 'inserted');
    await expectDeliveryError(() => sender.send({
      machineCredential: a.credential.raw,
      submissionId: randomUUID(), envelope,
      organizationId: orgB,
    }), 'invalid_request');
    console.log('PASS: two organizations independently persisted same UUID; forged tenant selector refused');

    stage = 'read-only membership-bound RLS history of genuine Linux samples';
    // The synthetic identities were created by the disposable baseline.
    // This is NOT a WorkOS authentication test and is never a live route.
    const ownerA = (await pool.query(
      'SELECT public.resolve_workos_user($1::text) AS id',
      ['user_agent_owner_a'],
    )).rows[0]?.id;
    const ownerB = (await pool.query(
      'SELECT public.resolve_workos_user($1::text) AS id',
      ['user_agent_owner_b'],
    )).rows[0]?.id;
    assert.match(ownerA ?? '', UUID);
    assert.match(ownerB ?? '', UUID);
    assert.notEqual(ownerA, ownerB);

    const historyA = await readDisposableTenantHistory(pool, {
      userId: ownerA, organizationId: orgA, agentId: a.agentId,
    });
    const historyB = await readDisposableTenantHistory(pool, {
      userId: ownerB, organizationId: orgB, agentId: b.agentId,
    });
    assert.equal(historyA.authorized, true);
    assert.equal(historyA.agentFound, true);
    assert.equal(historyA.samples.length, 1);
    assert.equal(historyB.authorized, true);
    assert.equal(historyB.agentFound, true);
    assert.equal(historyB.samples.length, 1);
    assert.ok(historyA.samples[0].recorded_at instanceof Date);
    assert.ok(historyB.samples[0].recorded_at instanceof Date);
    assert.deepEqual(Object.keys(historyA.samples[0]).sort(), [
      'recorded_at', 'received_at', 'cpu_usage_percent',
      'memory_usage_percent', 'disk_usage_percent',
      'network_receive_bytes_per_second', 'network_transmit_bytes_per_second',
    ].sort());
    assert.deepEqual(await readDisposableTenantHistory(pool, {
      userId: ownerA, organizationId: orgB, agentId: b.agentId,
    }), { authorized: false, agentFound: false, samples: [] });
    assert.deepEqual(await readDisposableTenantHistory(pool, {
      userId: ownerB, organizationId: orgA, agentId: a.agentId,
    }), { authorized: false, agentFound: false, samples: [] });
    assert.deepEqual(await readDisposableTenantHistory(pool, {
      userId: ownerA, organizationId: orgA, agentId: b.agentId,
    }), { authorized: true, agentFound: false, samples: [] });
    console.log('PASS: genuine Linux sample history visible only to verified tenant member/agent; no pooled context leak');

    stage = 'unknown and revoked machine credential rejection';
    const unknown = makeCredential();
    await expectDeliveryError(() => sender.send({
      machineCredential: unknown.raw, submissionId: randomUUID(), envelope,
    }), 'credential_rejected');
    const revoked = (await pool.query(`
      SELECT pulse_agent_enrollment.revoke_agent(
        $1::text,$2::uuid,$3::uuid
      ) AS revoked
    `, ['user_agent_owner_a', orgA, a.agentId])).rows[0]?.revoked;
    assert.equal(revoked, true);
    await expectDeliveryError(() => sender.send(submission), 'credential_rejected');
    console.log('PASS: unknown and revoked credentials denied by real PostgreSQL via HTTP 401');

    stage = 'test-only network quota and fail-closed HTTP';
    forcedNetworkRateLimit = true;
    const before = admitted;
    await expectDeliveryError(() => sender.send({
      machineCredential: b.credential.raw, submissionId: randomUUID(), envelope,
    }), 'rate_limited', 45);
    assert.equal(admitted, before);
    forcedNetworkRateLimit = false;
    const unmapped = await fetch(`${origin}/api/telemetry`, { method: 'POST' });
    assert.equal(unmapped.status, 404);
    console.log('PASS: HTTPS network quota -> 429 without automatic retry; legacy route absent');

    console.log('========== D15C-5T VERIFIED HTTPS + REAL POSTGRESQL: PASS ==========',
      '\nPUBLIC LAUNCH: NO_GO | disposable test only');
  } finally {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      });
    }
    await pool.end();
  }
}

main().catch(error => {
  // Never print driver error text, SQL, raw credential, transport origin, or files.
  console.error(`REFUSE_D15C5T_INTEGRATION: stage=${stage}`);
  console.error('ERROR CATEGORY:', typeof error?.code === 'string' ? error.code : error?.name ?? 'unknown');
  process.exitCode = 1;
});
