/**
 * D15B negative credential authorization test.
 * Only runs in the marked, disposable PostgreSQL cluster.
 * Uses synthetic hashes, never actual customer credentials.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const { Client } = pg;

const phase = process.argv[2];
const socket = process.env.PULSE_AGENT_SOCKET;
const data = process.env.PULSE_AGENT_DATA;

function guard() {
  assert.ok(['expired', 'missing-scope'].includes(phase));
  assert.equal(process.env.PULSE_AGENT_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.match(
    socket ?? '',
    /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/,
  );
  assert.equal(data, `${dirname(socket)}/data`);

  const marker = `${dirname(socket)}/.pulse-telemetry-marker`;
  assert.ok(existsSync(marker));
  assert.ok(lstatSync(marker).isFile());
  assert.equal(lstatSync(marker).isSymbolicLink(), false);
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
    application_name: 'pulse-d15b-credential-negative',
  });

  await client.connect();

  try {
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

    const observedAt = new Date().toISOString();
    const metrics = {
      'cpu.usage_percent': {
        metric: 'cpu.usage_percent',
        value: 35,
        unit: 'percent',
        status: 'measured',
        observedAt,
      },
    };

    const hash = phase === 'expired'
      ? '1'.repeat(64)
      : '2'.repeat(64);

    let rejected = false;

    try {
      await client.query(`
        SELECT pulse_telemetry_ingestion.ingest_submission(
          $1::text, $2::uuid, $3::text, $4::timestamptz,
          1, 35::real, NULL::real, NULL::real,
          NULL::bigint, NULL::bigint, $5::jsonb
        ) AS outcome
      `, [
        hash,
        randomUUID(),
        '3'.repeat(64),
        observedAt,
        JSON.stringify(metrics),
      ]);
    } catch (error) {
      assert.equal(
        error.code,
        '42501',
        `${phase}: unexpected SQLSTATE`,
      );
      rejected = true;
    }

    assert.ok(
      rejected,
      `${phase}: unauthorized credential was accepted`,
    );

    console.log(`PASS: ${phase} credential rejected by PostgreSQL`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('D15B CREDENTIAL NEGATIVE TEST FAILED');
  console.error(
    'ERROR CATEGORY:',
    error?.code ?? error?.name ?? 'unknown',
  );
  if (error?.name === 'AssertionError') {
    console.error('ASSERTION:', error.message);
  }
  process.exitCode = 1;
});
