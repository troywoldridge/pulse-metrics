/**
 * Pulse Metrics D15C-5U-2F2A — disposable PostgreSQL tenant-history probe.
 *
 * This is a TEST-ONLY SQL exercise of the same transaction-local membership
 * then organization-context ordering as src/db/tenant-context.ts. It is NOT
 * a replacement for that application helper, WorkOS, or the HTTP history API.
 * It never creates credentials, writes telemetry or opens a listener.
 *
 * The only caller is the locked D15C-5T disposable HTTPS->Postgres rehearsal.
 */

import { strict as assert } from 'node:assert';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMPTY = Object.freeze({ authorized: false, agentFound: false, samples: Object.freeze([]) });

/**
 * @param {{connect: () => Promise<{query: (sql: string, values?: unknown[]) => Promise<{rows: unknown[]}>, release: (error?: Error) => void}>}} pool
 * @param {{userId: string, organizationId: string, agentId: string}} context
 * @returns {Promise<{authorized: boolean, agentFound: boolean, samples: unknown[]}>}
 */
export async function readDisposableTenantHistory(pool, context) {
  if (!pool || typeof pool.connect !== 'function' || !context ||
      ![context.userId, context.organizationId, context.agentId].every(id =>
        typeof id === 'string' && UUID.test(id))) {
    throw new TypeError('Verified disposable identity required');
  }

  const client = await pool.connect();
  let began = false;
  let clean = false;
  let failed = false;
  try {
    // These values are safe for restricted app role. The privileged wrapper
    // already verified data_directory, socket ownership and no TCP listener.
    const identity = await client.query(`
      SELECT current_database() AS db, current_user AS role,
        current_setting('port') AS port,
        inet_server_addr() IS NULL AS unix_only
    `);
    assert.deepEqual(identity.rows, [{
      db: 'pulse_metrics', role: 'pulse_metrics_app',
      port: '55432', unix_only: true,
    }], 'Disposable restricted SQL connection required');

    // Verify no tenant-scoped readings are visible on a fresh pool session.
    const initial = await client.query(
      'SELECT count(*)::integer AS n FROM public.telemetry_samples',
    );
    assert.deepEqual(initial.rows, [{ n: 0 }], 'Unscoped session could read samples');

    await client.query('BEGIN READ ONLY');
    began = true;
    await client.query(`
      SELECT set_config('app.current_organization_id', '', true),
             set_config('app.current_user_id', $1::text, true)
    `, [context.userId]);

    const memberships = await client.query(`
      SELECT user_id FROM public.organization_memberships
      WHERE organization_id = $1::uuid AND user_id = $2::uuid LIMIT 1
    `, [context.organizationId, context.userId]);
    if (memberships.rows.length === 0) return EMPTY;
    assert.equal(memberships.rows.length, 1, 'Unexpected membership result');
    assert.equal(memberships.rows[0].user_id, context.userId);

    // Assign tenant context only AFTER proof of the actual membership.
    await client.query(`
      SELECT set_config('app.current_organization_id', $1::text, true)
    `, [context.organizationId]);
    const agents = await client.query(`
      SELECT id FROM public.monitored_agents
      WHERE organization_id = $1::uuid AND id = $2::uuid LIMIT 1
    `, [context.organizationId, context.agentId]);
    if (agents.rows.length === 0) {
      return { authorized: true, agentFound: false, samples: [] };
    }
    assert.equal(agents.rows.length, 1);
    assert.equal(agents.rows[0].id, context.agentId);

    // The same *bounded, explicit* columns used by history-service.ts. No
    // raw JSON, credential, identity secret, or cross-tenant query results.
    const result = await client.query(`
      SELECT recorded_at, received_at, cpu_usage_percent,
             memory_usage_percent, disk_usage_percent,
             network_receive_bytes_per_second,
             network_transmit_bytes_per_second
      FROM public.telemetry_samples
      WHERE organization_id = $1::uuid AND agent_id = $2::uuid
      ORDER BY recorded_at DESC, id DESC LIMIT 2
    `, [context.organizationId, context.agentId]);
    assert.ok(Array.isArray(result.rows) && result.rows.length <= 2);
    return { authorized: true, agentFound: true, samples: result.rows };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (began) await client.query('ROLLBACK');
      // Verify transaction-local context cannot leak via pooled connection.
      const after = await client.query(
        'SELECT count(*)::integer AS n FROM public.telemetry_samples',
      );
      assert.deepEqual(after.rows, [{ n: 0 }], 'Tenant session context leaked');
      clean = true;
    } finally {
      // Drop a connection if session reset was not independently proven.
      client.release(clean && !failed ? undefined : new Error('Unverified tenant SQL session'));
    }
  }
}
