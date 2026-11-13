/**
 * D15C-5A runtime privilege negative tests, disposable cluster only.
 * Does NOT send any user credentials or connect using DATABASE_URL.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const socket = process.env.PULSE_D15C5A_SOCKET;
const data = process.env.PULSE_D15C5A_DATA;

function guard() {
  assert.equal(process.env.PULSE_D15C5A_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.match(socket ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(data, `${dirname(socket)}/data`);
  const marker = `${dirname(socket)}/.pulse-telemetry-quota-marker`;
  assert.ok(existsSync(marker));
  assert.ok(lstatSync(marker).isFile());
  assert.equal(lstatSync(marker).isSymbolicLink(), false);
}

async function mustDeny(client, statement, label) {
  let error;
  try {
    await client.query(statement);
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, '42501', `${label}: expected permission denied`);
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
    statement_timeout: 5000,
    application_name: 'pulse-d15c5a-retention-privileges',
  });
  await client.connect();
  try {
    const identity = await client.query(`
      SELECT current_database() AS db, current_user AS role,
        session_user AS session_role, inet_server_addr() IS NULL AS local_only,
        current_setting('port') AS port
    `);
    assert.deepEqual(identity.rows[0], {
      db: 'pulse_metrics', role: 'pulse_metrics_app',
      session_role: 'pulse_metrics_app', local_only: true, port: '55432',
    });
    console.log('PASS: restricted application role verified on disposable socket');

    await mustDeny(client,
      'SELECT * FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()',
      'maintenance function execution');
    await mustDeny(client,
      'DELETE FROM pulse_telemetry_quota.network_buckets WHERE false',
      'network quota direct DELETE');
    await mustDeny(client,
      'DELETE FROM pulse_telemetry_agent_quota.agent_buckets WHERE false',
      'agent quota direct DELETE');
    await mustDeny(client,
      'SELECT * FROM pulse_telemetry_maintenance.schema_migrations',
      'private maintenance ledger');
    await mustDeny(client,
      'SET ROLE pulse_metrics_telemetry_maintenance_executor',
      'maintenance executor role');
    console.log('PASS: runtime denied function, private ledger, direct DELETE and role escalation');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('REFUSE_D15C5A_RUNTIME_TEST:',
    error?.name === 'AssertionError' ? error.message : (error?.code ?? 'unknown'));
  process.exitCode = 1;
});
