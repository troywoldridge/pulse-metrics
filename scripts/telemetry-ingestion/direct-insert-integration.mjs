/**
 * Pulse Metrics D15B — direct telemetry INSERT bypass test.
 *
 * Uses only the verified disposable PostgreSQL cluster.
 * Creates an authenticated synthetic agent and attempts to
 * bypass the credential-bound ingestion function.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const { Client } = pg;

const socket = process.env.PULSE_AGENT_SOCKET;
const data = process.env.PULSE_AGENT_DATA;
const org = process.env.PULSE_AGENT_ORG_A;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let stage = 'startup';

function guard() {
  assert.equal(process.env.PULSE_AGENT_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');

  assert.match(
    socket ?? '',
    /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/,
  );

  assert.equal(data, `${dirname(socket)}/data`);
  assert.match(org ?? '', UUID);

  const marker = `${dirname(socket)}/.pulse-telemetry-marker`;

  assert.ok(existsSync(marker));
  assert.ok(lstatSync(marker).isFile());
  assert.equal(lstatSync(marker).isSymbolicLink(), false);
}

function secret() {
  const hash = createHash('sha256')
    .update(randomBytes(32).toString('base64url'))
    .digest('hex');

  return { hash, prefix: hash.slice(0, 12) };
}

async function main() {
  guard();

  const client = new Client({
    host: socket,
    port: 55432,
    user: 'pulse_metrics_app',
    database: 'pulse_metrics',
    ssl: false,
    connectionTimeoutMillis: 2500,
    statement_timeout: 6000,
    application_name: 'pulse-d15b-direct-insert-test',
  });

  await client.connect();

  let transactionOpen = false;

  try {
    stage = 'verify restricted database identity';

    const identity = await client.query(`
      SELECT current_database() AS db,
             current_user AS role,
             session_user AS session_role,
             inet_server_addr() IS NULL AS socket_only,
             current_setting('port') AS port
    `);

    assert.equal(identity.rows[0]?.db, 'pulse_metrics');
    assert.equal(identity.rows[0]?.role, 'pulse_metrics_app');
    assert.equal(identity.rows[0]?.session_role, 'pulse_metrics_app');
    assert.equal(identity.rows[0]?.socket_only, true);
    assert.equal(identity.rows[0]?.port, '55432');

    console.log('PASS: restricted application session verified');

    stage = 'create valid synthetic agent';

    const enrollment = secret();
    const machine = secret();

    await client.query(`
      SELECT pulse_agent_enrollment.issue_enrollment(
        $1::text, $2::uuid, $3::text, $4::text,
        $5::text, $6::timestamptz
      )
    `, [
      'user_agent_owner_a',
      org,
      enrollment.hash,
      enrollment.prefix,
      'D15B direct-insert synthetic agent',
      new Date(Date.now() + 600000).toISOString(),
    ]);

    const redeemed = await client.query(`
      SELECT * FROM pulse_agent_enrollment.redeem_enrollment(
        $1::text, $2::text, $3::text, $4::text,
        $5::text, $6::text, $7::text
      )
    `, [
      enrollment.hash,
      machine.hash,
      machine.prefix,
      'D15B Direct Insert Test',
      'd15b-direct-insert.invalid',
      'linux',
      'x86_64',
    ]);

    assert.equal(redeemed.rowCount, 1);
    assert.equal(redeemed.rows[0].organization_id, org);
    assert.match(redeemed.rows[0].agent_id, UUID);

    const agentId = redeemed.rows[0].agent_id;

    console.log('PASS: real synthetic agent enrolled');

    stage = 'establish correct tenant context';

    await client.query('BEGIN');
    transactionOpen = true;

    await client.query(`
      SELECT set_config(
        'app.current_organization_id', $1::text, true
      )
    `, [org]);

    const visible = await client.query(`
      SELECT id
      FROM public.monitored_agents
      WHERE id = $1::uuid
        AND organization_id = $2::uuid
    `, [agentId, org]);

    assert.equal(
      visible.rowCount,
      1,
      'Valid synthetic agent not visible in correct tenant',
    );

    console.log(
      'PASS: correct tenant context and valid agent confirmed',
    );

    stage = 'attempt unauthorized direct telemetry INSERT';

    const now = new Date().toISOString();

    const metrics = {
      'cpu.usage_percent': {
        metric: 'cpu.usage_percent',
        value: 42,
        unit: 'percent',
        status: 'measured',
        observedAt: now,
      },
    };

    let rejection;

    try {
      await client.query(`
        INSERT INTO public.telemetry_samples (
          organization_id,
          agent_id,
          recorded_at,
          schema_version,
          cpu_usage_percent,
          metrics
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::timestamptz,
          1,
          42::real,
          $4::jsonb
        )
      `, [
        org,
        agentId,
        now,
        JSON.stringify(metrics),
      ]);
    } catch (error) {
      rejection = error;
    }

    assert.ok(
      rejection,
      'SECURITY FAILURE: direct INSERT unexpectedly succeeded',
    );

    assert.equal(
      rejection.code,
      '42501',
      'Direct INSERT failed for unexpected reason',
    );

    console.log(
      'PASS: direct INSERT denied even with valid agent and tenant',
    );

    // PostgreSQL aborts a transaction after a statement error.
    // Roll it back without retaining any attempted write.
    await client.query('ROLLBACK');
    transactionOpen = false;

    console.log('D15B DIRECT-WRITE BYPASS TEST PASSED');
  } finally {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
    }

    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error('D15B DIRECT-WRITE TEST FAILED');
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
