/**
 * Pulse Metrics D15B — restricted-role privilege abuse rehearsal.
 *
 * Tests operate only against the marked disposable PostgreSQL
 * cluster. Every probe runs inside a rolled-back transaction.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const { Client } = pg;

const SOCKET = process.env.PULSE_AGENT_SOCKET;
const DATA = process.env.PULSE_AGENT_DATA;

function guard() {
  assert.equal(process.env.PULSE_AGENT_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');

  assert.match(
    SOCKET ?? '',
    /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/,
  );

  assert.equal(DATA, `${dirname(SOCKET)}/data`);

  const marker = `${dirname(SOCKET)}/.pulse-telemetry-marker`;

  assert.ok(existsSync(marker));
  assert.ok(lstatSync(marker).isFile());
  assert.equal(lstatSync(marker).isSymbolicLink(), false);
}

async function deny(client, label, sql) {
  await client.query('BEGIN');

  let error;

  try {
    await client.query(sql);
  } catch (caught) {
    error = caught;
  } finally {
    await client.query('ROLLBACK');
  }

  assert.ok(error, `${label}: unexpectedly authorized`);
  assert.equal(
    error.code,
    '42501',
    `${label}: unexpected SQLSTATE`,
  );

  console.log(`PASS: ${label}`);
}

async function main() {
  guard();

  const client = new Client({
    host: SOCKET,
    port: 55432,
    user: 'pulse_metrics_app',
    database: 'pulse_metrics',
    ssl: false,
    connectionTimeoutMillis: 2500,
    statement_timeout: 6000,
    application_name: 'pulse-d15b-privilege-test',
  });

  await client.connect();

  try {
    const identity = await client.query(`
      SELECT current_database() AS database_name,
             current_user AS role_name,
             session_user AS session_role,
             inet_server_addr() IS NULL AS socket_only,
             current_setting('port') AS port
    `);

    const row = identity.rows[0];

    assert.equal(row.database_name, 'pulse_metrics');
    assert.equal(row.role_name, 'pulse_metrics_app');
    assert.equal(row.session_role, 'pulse_metrics_app');
    assert.equal(row.socket_only, true);
    assert.equal(row.port, '55432');

    console.log('PASS: restricted application identity verified');

    await deny(
      client,
      'cannot assume telemetry executor role',
      'SET LOCAL ROLE pulse_metrics_telemetry_executor',
    );

    await deny(
      client,
      'cannot read credential hashes',
      'SELECT token_hash FROM public.agent_credentials LIMIT 1',
    );

    await deny(
      client,
      'cannot modify credential revocation state',
      `UPDATE public.agent_credentials
       SET revoked_at = clock_timestamp()
       WHERE false`,
    );

    await deny(
      client,
      'cannot revoke agents through direct table UPDATE',
      `UPDATE public.monitored_agents
       SET status = 'revoked'
       WHERE false`,
    );

    await deny(
      client,
      'cannot read private submission receipts',
      'SELECT * FROM pulse_telemetry_ingestion.submissions',
    );

    await deny(
      client,
      'cannot insert forged private submission receipts',
      `INSERT INTO pulse_telemetry_ingestion.submissions
         (organization_id, agent_id, submission_id,
          payload_sha256, telemetry_sample_id)
       VALUES (
         '00000000-0000-4000-8000-000000000001',
         '00000000-0000-4000-8000-000000000002',
         '00000000-0000-4000-8000-000000000003',
         repeat('a',64), 1
       )`,
    );

    console.log('D15B PRIVILEGE ABUSE REHEARSAL PASSED');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('D15B PRIVILEGE ABUSE REHEARSAL FAILED');
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
