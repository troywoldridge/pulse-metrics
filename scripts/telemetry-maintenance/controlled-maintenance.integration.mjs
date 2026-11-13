/**
 * Pulse Metrics D15C-5C — review-only real PostgreSQL maintenance operations.
 * MUST be run only by the independent D15C-5C disposable cluster wrapper,
 * after D15C-5B completes and the test-only peer mapping/roles are installed.
 * This test never uses DATABASE_URL, passwords, real credentials, or a scheduler.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { MAINTENANCE_POLICY } from './controlled-maintenance-policy.mjs';

const { Client } = pg;
const socket = process.env.PULSE_D15C5C_SOCKET;
const dataDir = process.env.PULSE_D15C5C_DATA;
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const CLI = resolve(ROOT, 'scripts/telemetry-maintenance/controlled-maintenance-cli.mjs');
// Distinct, domain-separated synthetic fixture keys. The preceding D15C-3B
// rehearsal already owns repeat('a',64); never reuse a prior milestone key.
const fixtureDigest = label => createHash('sha256')
  .update(`pulse-d15c5c-fixture-${label}-v1`, 'utf8').digest('hex');
const ACTIVE_NETWORK_DIGEST = fixtureDigest('active-network');
const RECENT_NETWORK_DIGEST = fixtureDigest('recent-network');
let stage = 'initial_guard';
// A fixed vocabulary only: diagnostics must never echo SQL, network identities,
// postgres driver errors, environment values or customer information.
let overlapDiagnostic = 'not_started';
const SAFE_CONTROLLER_EVENTS = new Set([
  'configuration_denied', 'maintenance_failed', 'overlap_skipped',
  'maintenance_completed', 'maintenance_started', 'batch_completed',
]);
const SAFE_DIAGNOSTICS = new Set([
  'connection', 'identity_query', 'identity_assertion',
  'lock_query', 'lock_assertion', 'prune_query', 'prune_assertion',
  'unlock_query', 'unlock_assertion',
]);
function safeControllerEvent(result) {
  const event = result?.events?.at(-1)?.event;
  return SAFE_CONTROLLER_EVENTS.has(event) ? event : 'unexpected';
}
function guard() {
  assert.equal(process.env.PULSE_D15C5C_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.match(socket ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(dataDir, `${dirname(socket)}/data`);
  for (const markerName of ['.pulse-telemetry-quota-marker',
                            '.pulse-telemetry-agent-quota-marker']) {
    const marker = `${dirname(socket)}/${markerName}`;
    assert.ok(existsSync(marker));
    assert.ok(lstatSync(marker).isFile());
    assert.ok(!lstatSync(marker).isSymbolicLink());
  }
}

function connection(user) {
  return new Client({ host: socket, port: 55432,
    database: 'pulse_metrics', user, ssl: false,
    connectionTimeoutMillis: 2500, statement_timeout: 2500,
    query_timeout: 3500, application_name: 'pulse-d15c5c-operations-integration',
  });
}
function invokeCLI(envOverrides = {}) {
  const env = {
    ...process.env,
    PULSE_D15C5C_DISPOSABLE_ONLY: 'YES',
    PULSE_D15C5C_SOCKET: socket,
    PULSE_D15C5C_DATA: dataDir,
    PULSE_D15C5C_DIAGNOSTIC: 'DISPOSABLE_ONLY',
    ...envOverrides,
  };
  const call = spawnSync(process.execPath, [CLI], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 12000, maxBuffer: 128 * 1024,
  });
  assert.equal(call.signal, null, 'CLI timed out or was signaled');
  assert.ok(typeof call.stdout === 'string');
  const events = call.stdout.trim().split('\n')
    .filter(Boolean).map(line => {
      assert.match(line, /^D15C5C_EVENT \{.*\}$/);
      return JSON.parse(line.slice('D15C5C_EVENT '.length));
    });
  assert.ok(events.length > 0, 'CLI did not report any sanitized event');
  assert.equal(call.stdout.includes('postgres://'), false);
  assert.equal(call.stdout.includes('password'), false);
  assert.equal(call.stdout.includes(dataDir), false);
  assert.equal(call.stderr?.includes(dataDir), false);
  const diagnosticLines = (call.stderr ?? '').trim().split('\n').filter(Boolean);
  assert.ok(diagnosticLines.length <= 2, 'unrecognized diagnostics');
  const diagnostics = diagnosticLines.map(line => {
    const match = /^D15C5C_DIAGNOSTIC ([a-z_]+)$/.exec(line);
    assert.ok(match && SAFE_DIAGNOSTICS.has(match[1]), 'unsafe diagnostic output');
    return match[1];
  });
  return { code: call.status, events, stdout: call.stdout, diagnostics };
}
const last = o => o.events.at(-1);
async function countOld(db) {
  const r = await db.query(`
    SELECT
      (SELECT count(bucket_digest)::integer
       FROM pulse_telemetry_quota.network_buckets
       WHERE window_end < clock_timestamp() - interval '48 hours') AS network,
      (SELECT count(agent_id)::integer
       FROM pulse_telemetry_agent_quota.agent_buckets
       WHERE window_end < clock_timestamp() - interval '48 hours') AS agent
  `);
  return r.rows[0];
}

async function main() {
  guard();
  const fixture = connection('pulse_metrics_test_fixture');
  const maint = connection('pulse_metrics_test_maintainer');
  await fixture.connect();
  await maint.connect();
  try {
    stage = 'real-disposable-identity';
    const identity = await maint.query(`
      SELECT current_database() AS db, current_user AS role,
        session_user AS session_role,
        inet_server_addr() IS NULL AS local_only,
        current_setting('port') AS port,
        current_setting('listen_addresses') = '' AS tcp_disabled
    `);
    assert.deepEqual(identity.rows[0], {
      db: 'pulse_metrics', role: 'pulse_metrics_test_maintainer',
      session_role: 'pulse_metrics_test_maintainer',
      local_only: true, port: '55432', tcp_disabled: true,
    });

    stage = 'seed synthetic quota windows: expired network';
    await fixture.query(`
      INSERT INTO pulse_telemetry_quota.network_buckets
        (bucket_digest, attempts, window_end)
      SELECT md5('d15c5c-net-a-' || g::text) || md5('d15c5c-net-b-' || g::text),
        3, clock_timestamp() - interval '4 days'
      FROM generate_series(1,770) AS g
    `);
    stage = 'seed synthetic quota windows: expired agent';
    await fixture.query(`
      INSERT INTO pulse_telemetry_agent_quota.agent_buckets
        (organization_id, agent_id, attempts, window_end)
      SELECT gen_random_uuid(), gen_random_uuid(),
        3, clock_timestamp() - interval '4 days'
      FROM generate_series(1,770) AS g
    `);
    // A prior rehearsal intentionally leaves repeat('a',64) in the database.
    // Use independent 5C keys, and refuse any collision rather than doing
    // ON CONFLICT UPDATE/NOTHING, which could hide corrupt test assumptions.
    stage = 'preflight isolated current and recent network fixture identities';
    assert.notEqual(ACTIVE_NETWORK_DIGEST, RECENT_NETWORK_DIGEST);
    const fixtureKeyCollision = await fixture.query(`
      SELECT count(bucket_digest)::integer AS n
      FROM pulse_telemetry_quota.network_buckets
      WHERE bucket_digest = ANY($1::text[])
    `, [[ACTIVE_NETWORK_DIGEST, RECENT_NETWORK_DIGEST]]);
    assert.equal(fixtureKeyCollision.rows[0]?.n, 0,
      'D15C-5C fixture network keys must be unused before seeding');
    stage = 'seed synthetic quota windows: current and recent network';
    const networkFixtures = await fixture.query(`
      INSERT INTO pulse_telemetry_quota.network_buckets
        (bucket_digest, attempts, window_end)
      VALUES
        ($1::text, 5, clock_timestamp() + interval '60 seconds'),
        ($2::text, 5, clock_timestamp() - interval '1 hour')
      RETURNING bucket_digest
    `, [ACTIVE_NETWORK_DIGEST, RECENT_NETWORK_DIGEST]);
    assert.equal(networkFixtures.rowCount, 2);
    stage = 'seed synthetic quota windows: current and recent agents';
    const agents = await fixture.query(`
      INSERT INTO pulse_telemetry_agent_quota.agent_buckets
        (organization_id, agent_id, attempts, window_end)
      VALUES
        (gen_random_uuid(), gen_random_uuid(), 5, clock_timestamp() + interval '60 seconds'),
        (gen_random_uuid(), gen_random_uuid(), 5, clock_timestamp() - interval '1 hour')
      RETURNING organization_id, agent_id
    `);
    assert.equal(agents.rowCount, 2);
    assert.deepEqual(await countOld(fixture), { network: 770, agent: 770 });

    stage = 'missing-or-production-guard-must-deny-before-db';
    for (const overrides of [
      { PULSE_D15C5C_DISPOSABLE_ONLY: '' },
      { NODE_ENV: 'production' },
      { PGPASSWORD: 'SECRET_PASSWORD_SAMPLE_DO_NOT_PRINT' },
    ]) {
      const refusal = invokeCLI(overrides);
      assert.equal(refusal.code, 1);
      assert.deepEqual(last(refusal), { event: 'configuration_denied', alert: true });
      assert.deepEqual(await countOld(fixture), { network: 770, agent: 770 });
    }
    console.log('PASS: missing approval, production mode and password environment fail before DB');

    stage = 'advisory-lock-owner-acquire';
    overlapDiagnostic = 'owner_acquiring';
    const held = await maint.query(
      'SELECT pg_advisory_lock($1::integer,$2::integer) AS held',
      [MAINTENANCE_POLICY.lockKeyA, MAINTENANCE_POLICY.lockKeyB],
    );
    assert.equal(held.rowCount, 1);
    overlapDiagnostic = 'owner_holds_lock';
    try {
      // First confirm that a second independent, restricted fixture session
      // cannot acquire the same lock. Do not weaken privileges or modify it.
      stage = 'advisory-lock-independent-probe';
      const probe = await fixture.query(
        'SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired',
        [MAINTENANCE_POLICY.lockKeyA, MAINTENANCE_POLICY.lockKeyB],
      );
      assert.equal(probe.rowCount, 1);
      if (probe.rows[0]?.acquired === true) {
        // This should never happen: release an unexpectedly acquired probe
        // lock on the same fixture session before failing closed.
        const releaseProbe = await fixture.query(
          'SELECT pg_advisory_unlock($1::integer,$2::integer) AS released',
          [MAINTENANCE_POLICY.lockKeyA, MAINTENANCE_POLICY.lockKeyB],
        );
        assert.equal(releaseProbe.rows[0]?.released, true);
        overlapDiagnostic = 'independent_probe_acquired_lock';
        assert.fail('independent PostgreSQL session unexpectedly acquired the held lock');
      }
      assert.equal(probe.rows[0]?.acquired, false);
      overlapDiagnostic = 'independent_probe_denied_as_expected';

      stage = 'advisory-lock-controller-invocation';
      const skipped = invokeCLI();
      const event = safeControllerEvent(skipped);
      const phase = skipped.diagnostics.at(-1);
      overlapDiagnostic = `controller_exit_${skipped.code === 0 ? 'zero' : 'nonzero'}_event_${event}` +
        (SAFE_DIAGNOSTICS.has(phase) ? `_phase_${phase}` : '_phase_unreported');
      stage = 'advisory-lock-controller-exit-status';
      assert.equal(skipped.code, 0);
      stage = 'advisory-lock-controller-overlap-event';
      assert.deepEqual(last(skipped), { event: 'overlap_skipped', alert: false });
      stage = 'advisory-lock-preserved-bucket-counts';
      assert.deepEqual(await countOld(fixture), { network: 770, agent: 770 });
      overlapDiagnostic = 'overlap_verified';
    } finally {
      const previousStage = stage;
      stage = 'advisory-lock-owner-release';
      const released = await maint.query(
        'SELECT pg_advisory_unlock($1::integer,$2::integer) AS released',
        [MAINTENANCE_POLICY.lockKeyA, MAINTENANCE_POLICY.lockKeyB],
      );
      assert.equal(released.rows[0]?.released, true);
      stage = previousStage;
    }
    console.log('PASS: overlapping maintenance run skipped with no cleanup writes');

    stage = 'bounded-three-batch-run';
    const first = invokeCLI();
    assert.equal(first.code, 0);
    assert.deepEqual(last(first), {
      event: 'maintenance_completed', batches: 3,
      networkRemoved: 750, agentRemoved: 750,
      possibleBacklog: true, alert: true,
    });
    assert.equal(first.events.filter(x => x.event === 'batch_completed').length, 3);
    assert.deepEqual(await countOld(fixture), { network: 20, agent: 20 });
    console.log('PASS: bounded maintenance removed 750+750 and emitted backlog review signal');

    stage = 'bounded-remainder-run';
    const second = invokeCLI();
    assert.equal(second.code, 0);
    assert.deepEqual(last(second), {
      event: 'maintenance_completed', batches: 2,
      networkRemoved: 20, agentRemoved: 20,
      possibleBacklog: false, alert: false,
    });
    assert.deepEqual(await countOld(fixture), { network: 0, agent: 0 });
    // Application/current and recently expired rows still present.
    const current = await fixture.query(`
      SELECT count(bucket_digest)::integer AS n
      FROM pulse_telemetry_quota.network_buckets
      WHERE bucket_digest = ANY($1::text[])
    `, [[ACTIVE_NETWORK_DIGEST, RECENT_NETWORK_DIGEST]]);
    assert.equal(current.rows[0]?.n, 2);
    const preserved = await fixture.query(`
      SELECT count(agent_id)::integer AS n
      FROM pulse_telemetry_agent_quota.agent_buckets
      WHERE (organization_id,agent_id) IN (($1::uuid,$2::uuid),($3::uuid,$4::uuid))
    `, [agents.rows[0].organization_id, agents.rows[0].agent_id,
        agents.rows[1].organization_id, agents.rows[1].agent_id]);
    assert.equal(preserved.rows[0]?.n, 2);
    console.log('PASS: second bounded run drained remainder; current/recent buckets survived');

    stage = 'no-work-check';
    const idle = invokeCLI();
    assert.equal(idle.code, 0);
    assert.deepEqual(last(idle), { event: 'maintenance_completed',
      batches: 1, networkRemoved: 0, agentRemoved: 0,
      possibleBacklog: false, alert: false });
    console.log('PASS: no-work result is bounded; no production scheduler activated');

    stage = 'maintenance-session-disconnect-releases-advisory-lock';
    await maint.query(
      'SELECT pg_advisory_lock($1::integer,$2::integer)',
      [MAINTENANCE_POLICY.lockKeyA, MAINTENANCE_POLICY.lockKeyB],
    );
    await maint.end(); // PostgreSQL must release the session lock on disconnect.
    const afterDisconnect = invokeCLI();
    assert.equal(afterDisconnect.code, 0);
    assert.deepEqual(last(afterDisconnect), {
      event: 'maintenance_completed', batches: 1,
      networkRemoved: 0, agentRemoved: 0,
      possibleBacklog: false, alert: false,
    });
    console.log('PASS: PostgreSQL session disconnect releases cooperative maintenance lock');
    console.log('D15C-5C DISPOSABLE MAINTENANCE OPERATIONS PASSED');
  } finally {
    await Promise.allSettled([fixture.end(), maint.end()]);
  }
}

main().catch(error => {
  const category = typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
    ? error.code : 'CHECK_FAILED';
  console.error(`REFUSE_D15C5C_OPERATIONS: stage=${stage}`);
  console.error(`ERROR CATEGORY: ${category}`);
  if (stage.startsWith('advisory-lock-')) {
    console.error(`SAFE OVERLAP DIAGNOSTIC: ${overlapDiagnostic}`);
  }
  process.exitCode = 1;
});
