/**
 * Pulse Metrics D15C-5U-2F2E — READ-ONLY replay audit after a REAL restart
 * of the D15C-5T fully DISPOSABLE PostgreSQL cluster. Not a live service.
 * Never starts PostgreSQL, writes data, mounts routes or handles credentials.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { readDisposableTenantHistory } from './disposable-tenant-history.mjs';
import {
  validateRestartEnvironment, validateDatabaseIdentity,
  validateAgentRow, validateReadback, validateDeniedReadback,
} from './pilot-restart-policy.mjs';

const { Pool } = pg;
let phase = 'admission';
const context = validateRestartEnvironment(process.env);
const marker = `${dirname(context.socket)}/.pulse-telemetry-agent-quota-marker`;
assert.ok(existsSync(marker));
assert.ok(lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink());

/** Scoped, read-only discovery through the same restricted runtime role. */
async function ownAgent(pool, userId, orgId, hostname, expectedStatus) {
  const client = await pool.connect();
  let started = false;
  let provedClean = false;
  let failed = false;
  try {
    const before = await client.query('SELECT count(*)::integer AS n FROM public.telemetry_samples');
    assert.deepEqual(before.rows, [{ n: 0 }]);
    await client.query('BEGIN READ ONLY');
    started = true;
    await client.query(`
      SELECT set_config('app.current_organization_id', '', true),
             set_config('app.current_user_id', $1::text, true)
    `, [userId]);
    const membership = await client.query(`
      SELECT user_id FROM public.organization_memberships
      WHERE organization_id=$1::uuid AND user_id=$2::uuid LIMIT 2
    `, [orgId, userId]);
    assert.deepEqual(membership.rows, [{ user_id: userId }]);
    await client.query(`SELECT set_config('app.current_organization_id', $1::text, true)`, [orgId]);
    const agents = await client.query(`
      SELECT id, status FROM public.monitored_agents
      WHERE organization_id=$1::uuid AND hostname=$2::text LIMIT 2
    `, [orgId, hostname]);
    return validateAgentRow(agents.rows, expectedStatus);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (started) await client.query('ROLLBACK');
      const after = await client.query('SELECT count(*)::integer AS n FROM public.telemetry_samples');
      assert.deepEqual(after.rows, [{ n: 0 }], 'RLS context leaked after PostgreSQL restart');
      provedClean = true;
    } finally {
      client.release(provedClean && !failed ? undefined : new Error('Unverified PostgreSQL session'));
    }
  }
}

async function main() {
  const pool = new Pool({
    host: context.socket, port: 55432, user: 'pulse_metrics_app',
    database: 'pulse_metrics', ssl: false, max: 3,
    connectionTimeoutMillis: 2500, statement_timeout: 15_000,
    application_name: 'pulse-d15c5u2f2e-disposable-restart-audit',
  });
  try {
    phase = 'pinned restricted database identity';
    const identity = await pool.query(`
      SELECT current_database() AS db, current_user AS role,
        current_setting('port') AS port,
        inet_server_addr() IS NULL AND inet_server_port() IS NULL AS unix_only
    `);
    assert.equal(identity.rows.length, 1);
    validateDatabaseIdentity(identity.rows[0], context);

    phase = 'post-restart owner-bound agent discovery';
    const agentA = await ownAgent(pool, context.ownerA, context.orgA, 'd15c5t-a.invalid', 'revoked');
    const agentB = await ownAgent(pool, context.ownerB, context.orgB, 'd15c5t-b.invalid', 'active');
    assert.notEqual(agentA, agentB);

    phase = 'post-restart genuine telemetry readback under RLS';
    const a = await readDisposableTenantHistory(pool, {
      userId: context.ownerA, organizationId: context.orgA, agentId: agentA,
    });
    const b = await readDisposableTenantHistory(pool, {
      userId: context.ownerB, organizationId: context.orgB, agentId: agentB,
    });
    validateReadback(a);
    validateReadback(b);
    validateDeniedReadback(await readDisposableTenantHistory(pool, {
      userId: context.ownerA, organizationId: context.orgB, agentId: agentB,
    }));
    validateDeniedReadback(await readDisposableTenantHistory(pool, {
      userId: context.ownerB, organizationId: context.orgA, agentId: agentA,
    }));
    validateDeniedReadback(await readDisposableTenantHistory(pool, {
      userId: context.ownerA, organizationId: context.orgA, agentId: agentB,
    }), true);

    phase = 'post-restart credential grant denial';
    await assert.rejects(
      pool.query('SELECT count(*) FROM public.agent_credentials'),
      error => error?.code === '42501',
    );
    const unscoped = await pool.query('SELECT count(*)::integer AS n FROM public.telemetry_samples');
    assert.deepEqual(unscoped.rows, [{ n: 0 }]);
    console.log('PASS: genuine Linux telemetry and tenant-isolated history survived disposable PostgreSQL restart');
    console.log('PASS: revoked agent stayed revoked; restricted credential reads and session leakage denied');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(`REFUSE_D15C5U2F2E: phase=${phase}`);
  console.error('ERROR CATEGORY:', typeof error?.code === 'string' ? error.code : error?.name ?? 'unknown');
  process.exitCode = 1;
});
