/**
 * Pulse Metrics D15B — controlled administrative lock-order rehearsal.
 *
 * Uses a marker-verified, TCP-disabled, disposable PostgreSQL cluster.
 * All credentials and identities are synthetic.
 * Never logs secrets, SQL parameters, or raw driver diagnostics.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

function freshSecret() {
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
    statement_timeout: 12000,
    application_name: 'pulse-d15b-lock-test',
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

    const row = result.rows[0];

    assert.equal(row.db, 'pulse_metrics');
    assert.equal(row.role, 'pulse_metrics_app');
    assert.equal(row.session_role, 'pulse_metrics_app');
    assert.equal(row.socket_only, true);
    assert.equal(row.port, '55432');

    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

async function enroll(client, suffix) {
  const enrollment = freshSecret();
  const machine = freshSecret();

  const issued = await client.query(`
    SELECT pulse_agent_enrollment.issue_enrollment(
      $1::text,$2::uuid,$3::text,$4::text,
      $5::text,$6::timestamptz
    ) AS id
  `, [
    'user_agent_owner_a',
    ORG,
    enrollment.hash,
    enrollment.prefix,
    `D15B controlled lock ${suffix}`,
    new Date(Date.now() + 600000).toISOString(),
  ]);

  assert.match(issued.rows[0]?.id ?? '', UUID);

  const redeemed = await client.query(`
    SELECT * FROM pulse_agent_enrollment.redeem_enrollment(
      $1::text,$2::text,$3::text,$4::text,
      $5::text,$6::text,$7::text
    )
  `, [
    enrollment.hash,
    machine.hash,
    machine.prefix,
    `D15B Lock Agent ${suffix}`,
    `d15b-lock-${suffix}.invalid`,
    'linux',
    'x86_64',
  ]);

  assert.equal(redeemed.rowCount, 1);
  assert.equal(redeemed.rows[0].organization_id, ORG);
  assert.match(redeemed.rows[0].agent_id, UUID);

  return {
    agentId: redeemed.rows[0].agent_id,
    machine,
  };
}

function measurement(value) {
  const recordedAt = new Date().toISOString();

  return {
    id: randomUUID(),
    recordedAt,
    value,
    metrics: {
      'cpu.usage_percent': {
        metric: 'cpu.usage_percent',
        value,
        unit: 'percent',
        status: 'measured',
        observedAt: recordedAt,
      },
    },
  };
}

async function ingest(client, machine, item) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(item.metrics))
    .digest('hex');

  const result = await client.query(`
    SELECT pulse_telemetry_ingestion.ingest_submission(
      $1::text,$2::uuid,$3::text,$4::timestamptz,
      $5::integer,$6::real,$7::real,$8::real,
      $9::bigint,$10::bigint,$11::jsonb
    ) AS outcome
  `, [
    machine.hash,
    item.id,
    fingerprint,
    item.recordedAt,
    1,
    item.value,
    null,
    null,
    null,
    null,
    JSON.stringify(item.metrics),
  ]);

  assert.equal(result.rowCount, 1);
  return result.rows[0].outcome;
}

async function denied(promise, expectedCode) {
  let caught;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'Unauthorized operation succeeded');
  assert.equal(caught.code, expectedCode);
}

async function waitForBlocking(observer, waitingPid, blockingPid) {
  // pg_blocking_pids observes the PostgreSQL lock manager.
  // A timer alone would not prove that a request reached a lock.
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await observer.query(`
      SELECT pg_blocking_pids($1::integer) AS blockers
    `, [waitingPid]);

    if (result.rows[0]?.blockers?.includes(blockingPid)) {
      return;
    }

    await delay(100);
  }

  throw new Error('Expected database lock contention was not observed');
}

async function administrativeChange(
  admin,
  action,
  agentId,
  replacement,
) {
  if (action === 'revoke') {
    const result = await admin.query(`
      SELECT pulse_agent_enrollment.revoke_agent(
        $1::text,$2::uuid,$3::uuid
      ) AS changed
    `, [
      'user_agent_owner_a',
      ORG,
      agentId,
    ]);

    assert.equal(result.rows[0]?.changed, true);
    return;
  }

  if (action === 'rotate') {
    assert.ok(replacement);

    const result = await admin.query(`
      SELECT pulse_agent_enrollment.rotate_credential(
        $1::text,$2::uuid,$3::uuid,$4::text,$5::text
      ) AS changed
    `, [
      'user_agent_owner_a',
      ORG,
      agentId,
      replacement.hash,
      replacement.prefix,
    ]);

    assert.equal(result.rows[0]?.changed, true);
    return;
  }

  throw new Error('Unexpected administrative action');
}

async function raceAdministrativeChange({
  admin,
  ingestClient,
  observer,
  agent,
  action,
  replacement,
}) {
  const item = measurement(action === 'revoke' ? 61 : 62);

  let transactionOpen = false;
  let pending;

  try {
    stage = `${action}: administrator transaction`;

    await admin.query('BEGIN');
    transactionOpen = true;

    await administrativeChange(
      admin,
      action,
      agent.agentId,
      replacement,
    );

    stage = `${action}: ingest must wait on administrative lock`;

    // Capture the result immediately to avoid unhandled rejections.
    pending = ingest(
      ingestClient,
      agent.machine,
      item,
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, code: error?.code }),
    );

    await waitForBlocking(
      observer,
      ingestClient.processID,
      admin.processID,
    );

    console.log(
      `PASS: ${action} transaction blocked concurrent ingestion`,
    );

    stage = `${action}: commit administrative change`;

    await admin.query('COMMIT');
    transactionOpen = false;

    stage = `${action}: old credential denied after commit`;

    const outcome = await pending;

    assert.equal(
      outcome.ok,
      false,
      'Old credential unexpectedly persisted telemetry',
    );

    assert.equal(
      outcome.code,
      '42501',
      'Unexpected error after administrative change',
    );

    console.log(
      `PASS: ${action} committed before old credential could ingest`,
    );
  } finally {
    if (transactionOpen) {
      await admin.query('ROLLBACK').catch(() => {});
    }

    if (pending) {
      await pending.catch(() => {});
    }
  }
}

async function main() {
  guard();

  const clients = [];

  try {
    stage = 'create independent restricted sessions';

    for (let i = 0; i < 3; i++) {
      clients.push(await connect());
    }

    const [admin, ingestClient, observer] = clients;

    assert.notEqual(admin.processID, ingestClient.processID);
    assert.notEqual(admin.processID, observer.processID);
    assert.notEqual(ingestClient.processID, observer.processID);

    console.log('PASS: three independent restricted sessions');

    stage = 'enroll synthetic revocation agent';
    const revokedAgent = await enroll(admin, 'revoke');

    await raceAdministrativeChange({
      admin,
      ingestClient,
      observer,
      agent: revokedAgent,
      action: 'revoke',
    });

    stage = 'enroll synthetic rotation agent';
    const rotatingAgent = await enroll(admin, 'rotate');
    const replacement = freshSecret();

    await raceAdministrativeChange({
      admin,
      ingestClient,
      observer,
      agent: rotatingAgent,
      action: 'rotate',
      replacement,
    });

    stage = 'replacement credential accepted';

    assert.equal(
      await ingest(
        ingestClient,
        replacement,
        measurement(63),
      ),
      'inserted',
    );

    console.log(
      'PASS: replacement credential works after committed rotation',
    );

    stage = 'old credential remains denied';

    await denied(
      ingest(
        ingestClient,
        rotatingAgent.machine,
        measurement(64),
      ),
      '42501',
    );

    console.log(
      'PASS: old credential remains invalid after rotation',
    );

    console.log('D15B CONTROLLED LOCK REHEARSAL PASSED');
  } finally {
    await Promise.all(
      clients.map((client) =>
        client.end().catch(() => {}),
      ),
    );
  }
}

main().catch((error) => {
  console.error('D15B CONTROLLED LOCK REHEARSAL FAILED');
  console.error(`FAILED STAGE: ${stage}`);
  console.error(
    'ERROR CATEGORY:',
    typeof error?.code === 'string'
      ? error.code
      : error?.name ?? 'unknown',
  );

  if (error?.name === 'AssertionError') {
    console.error('ASSERTION:', error.message);
  }

  process.exitCode = 1;
});
