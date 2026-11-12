/**
 * Pulse Metrics D15B — real PostgreSQL concurrency rehearsal.
 *
 * Runs ONLY against the marker-verified disposable PostgreSQL cluster.
 * Uses synthetic organizations, machine credentials and telemetry.
 * Never displays secrets or raw database errors.
 */

import assert from 'node:assert/strict';
import pg from 'pg';
import {
  randomUUID,
  randomBytes,
  createHash,
} from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const { Client } = pg;

const SOCKET = process.env.PULSE_AGENT_SOCKET;
const DATA = process.env.PULSE_AGENT_DATA;
const ORG = process.env.PULSE_AGENT_ORG_A;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let stage = 'startup';

function guard() {
  assert.equal(process.env.PULSE_AGENT_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');

  assert.match(
    SOCKET ?? '',
    /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/,
  );

  assert.equal(DATA, `${dirname(SOCKET)}/data`);
  assert.match(ORG ?? '', UUID);

  const marker = `${dirname(SOCKET)}/.pulse-telemetry-marker`;

  assert.ok(existsSync(marker));
  assert.ok(lstatSync(marker).isFile());
  assert.equal(lstatSync(marker).isSymbolicLink(), false);
}

function credential() {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256')
    .update(raw, 'utf8')
    .digest('hex');

  return {
    hash,
    prefix: hash.slice(0, 12),
  };
}

async function connect() {
  guard();

  const client = new Client({
    host: SOCKET,
    port: 55432,
    user: 'pulse_metrics_app',
    database: 'pulse_metrics',
    ssl: false,
    connectionTimeoutMillis: 2500,
    statement_timeout: 10000,
    application_name: 'pulse-d15b-concurrency',
  });

  await client.connect();

  try {
    const result = await client.query(`
      SELECT current_database() AS db,
             current_user AS role,
             session_user AS session_role,
             inet_server_addr() IS NULL AS socket_only,
             current_setting('port') AS port
    `);

    const r = result.rows[0];

    assert.equal(r.db, 'pulse_metrics');
    assert.equal(r.role, 'pulse_metrics_app');
    assert.equal(r.session_role, 'pulse_metrics_app');
    assert.equal(r.socket_only, true);
    assert.equal(r.port, '55432');

    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

async function enroll(client) {
  const token = credential();
  const machine = credential();

  const issued = await client.query(`
    SELECT pulse_agent_enrollment.issue_enrollment(
      $1::text,$2::uuid,$3::text,$4::text,
      $5::text,$6::timestamptz
    ) AS id
  `, [
    'user_agent_owner_a',
    ORG,
    token.hash,
    token.prefix,
    'D15B concurrent synthetic agent',
    new Date(Date.now() + 600000).toISOString(),
  ]);

  assert.match(issued.rows[0]?.id ?? '', UUID);

  const redeemed = await client.query(`
    SELECT * FROM pulse_agent_enrollment.redeem_enrollment(
      $1::text,$2::text,$3::text,$4::text,
      $5::text,$6::text,$7::text
    )
  `, [
    token.hash,
    machine.hash,
    machine.prefix,
    'D15B Concurrency Agent',
    'd15b-concurrency.invalid',
    'linux',
    'x86_64',
  ]);

  assert.equal(redeemed.rowCount, 1);
  assert.equal(redeemed.rows[0].organization_id, ORG);
  assert.match(redeemed.rows[0].agent_id, UUID);

  return {
    machine,
    agentId: redeemed.rows[0].agent_id,
  };
}

function measurement(value = 40, id = randomUUID()) {
  const recordedAt = new Date().toISOString();

  const metrics = {
    'cpu.usage_percent': {
      metric: 'cpu.usage_percent',
      value,
      unit: 'percent',
      status: 'measured',
      observedAt: recordedAt,
    },
  };

  return {
    id,
    recordedAt,
    cpu: value,
    metrics,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(metrics))
      .digest('hex'),
  };
}

function changeMeasurement(item, newValue) {
  const metrics = {
    'cpu.usage_percent': {
      ...item.metrics['cpu.usage_percent'],
      value: newValue,
    },
  };

  return {
    ...item,
    cpu: newValue,
    metrics,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(metrics))
      .digest('hex'),
  };
}

async function ingest(client, machine, item) {
  const r = await client.query(`
    SELECT pulse_telemetry_ingestion.ingest_submission(
      $1::text,$2::uuid,$3::text,$4::timestamptz,
      $5::integer,$6::real,$7::real,$8::real,
      $9::bigint,$10::bigint,$11::jsonb
    ) AS outcome
  `, [
    machine.hash,
    item.id,
    item.fingerprint,
    item.recordedAt,
    1,
    item.cpu,
    null,
    null,
    null,
    null,
    JSON.stringify(item.metrics),
  ]);

  assert.equal(r.rowCount, 1);
  return r.rows[0].outcome;
}

async function revoke(client, agentId) {
  const r = await client.query(`
    SELECT pulse_agent_enrollment.revoke_agent(
      $1::text,$2::uuid,$3::uuid
    ) AS revoked
  `, [
    'user_agent_owner_a',
    ORG,
    agentId,
  ]);

  assert.equal(r.rows[0]?.revoked, true);
}

async function expectDenied(operation, code) {
  let caught;

  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'Expected PostgreSQL to deny operation');
  assert.equal(caught.code, code);
}

async function main() {
  guard();

  const clients = [];

  try {
    stage = 'open independent app sessions';

    for (let i = 0; i < 8; i++) {
      clients.push(await connect());
    }

    console.log('PASS: eight restricted independent sessions');

    stage = 'synthetic agent enrollment';
    const agent = await enroll(clients[0]);

    console.log('PASS: synthetic agent enrolled');

    stage = 'eight identical simultaneous submissions';

    const identical = measurement(41);

    const results = await Promise.all(
      clients.map((client) =>
        ingest(client, agent.machine, identical),
      ),
    );

    assert.equal(
      results.filter((v) => v === 'inserted').length,
      1,
    );

    assert.equal(
      results.filter((v) => v === 'duplicate').length,
      7,
    );

    console.log(
      'PASS: eight identical requests produced one insert and seven duplicates',
    );

    stage = 'two conflicting simultaneous submissions';

    const base = measurement(47);
    const alternate = changeMeasurement(base, 48);

    const conflicts = await Promise.all([
      ingest(clients[0], agent.machine, base),
      ingest(clients[1], agent.machine, alternate),
    ]);

    assert.equal(
      conflicts.filter((v) => v === 'inserted').length,
      1,
    );

    assert.equal(
      conflicts.filter((v) => v === 'conflict').length,
      1,
    );

    console.log(
      'PASS: conflicting requests produced one insert and one conflict',
    );

    stage = 'simultaneous revocation and telemetry';

    const raceItem = measurement(53);

    const race = await Promise.allSettled([
      revoke(clients[0], agent.agentId),
      ingest(clients[1], agent.machine, raceItem),
    ]);

    assert.equal(race[0].status, 'fulfilled');

    if (race[1].status === 'fulfilled') {
      assert.equal(race[1].value, 'inserted');
    } else {
      assert.equal(race[1].reason?.code, '42501');
    }

    console.log(
      'PASS: racing revocation and submission had an allowed serialized outcome',
    );

    stage = 'post-revocation ingestion denial';

    await expectDenied(
      () => ingest(
        clients[2],
        agent.machine,
        measurement(54),
      ),
      '42501',
    );

    await expectDenied(
      () => ingest(
        clients[3],
        agent.machine,
        identical,
      ),
      '42501',
    );

    console.log(
      'PASS: revoked agent cannot submit or replay after revocation',
    );

    console.log('D15B CONCURRENCY REHEARSAL PASSED');
  } finally {
    await Promise.all(
      clients.map((client) =>
        client.end().catch(() => {}),
      ),
    );
  }
}

main().catch((error) => {
  console.error('D15B CONCURRENCY REHEARSAL FAILED');
  console.error(`FAILED STAGE: ${stage}`);

  console.error(
    `ERROR CATEGORY: ${
      typeof error?.code === 'string'
        ? error.code
        : error?.name ?? 'unknown-error'
    }`,
  );

  if (error?.name === 'AssertionError') {
    console.error(`ASSERTION: ${error.message}`);
  }

  process.exitCode = 1;
});
