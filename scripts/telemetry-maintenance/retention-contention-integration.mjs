/**
 * Pulse Metrics D15C-5B — disposable PostgreSQL concurrency / retention test.
 *
 * REVIEW ONLY. Uses temporary Unix-socket PostgreSQL 16 and synthetic identities.
 * The wrapper independently validates the temporary cluster and creates two
 * peer-authenticated *test-only* logins: a maintenance caller and fixture maker.
 * Neither login, any secret, any SQL fixture, nor any permission is production.
 *
 * The ordinary app role is exercised through its REAL quota and ingestion
 * SECURITY DEFINER functions. It never acquires maintenance table privileges.
 * Test fixtures only may edit private bucket expiry timestamps, so this test
 * can prove adversarial lock ordering without waiting 48 hours.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const SOCKET = process.env.PULSE_D15C5B_SOCKET;
const DATA = process.env.PULSE_D15C5B_DATA;
const ORG_A = process.env.PULSE_D15C5B_ORG_A;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let stage = 'startup';

function guard() {
  assert.equal(process.env.PULSE_D15C5B_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.match(SOCKET ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(DATA, `${dirname(SOCKET)}/data`);
  assert.match(ORG_A ?? '', UUID);
  for (const name of ['.pulse-telemetry-quota-marker',
                      '.pulse-telemetry-agent-quota-marker']) {
    const marker = `${dirname(SOCKET)}/${name}`;
    assert.ok(existsSync(marker));
    assert.ok(lstatSync(marker).isFile());
    assert.equal(lstatSync(marker).isSymbolicLink(), false);
  }
}

function pool(user, max = 8) {
  return new Pool({
    host: SOCKET, port: 55432, user, database: 'pulse_metrics',
    ssl: false, connectionTimeoutMillis: 3000,
    statement_timeout: 20000, max,
    application_name: 'pulse-d15c5b-disposable-contention',
  });
}

const networkKey = label => createHash('sha256')
  .update(`pulse-d15c5b-${label}`, 'utf8').digest('hex');
const secret = () => {
  const hash = createHash('sha256')
    .update(randomBytes(32).toString('base64url'), 'utf8')
    .digest('hex');
  return { hash, prefix: hash.slice(0, 12) };
};
function sample(value = 42) {
  const recordedAt = new Date().toISOString();
  const metrics = {
    'cpu.usage_percent': {
      metric: 'cpu.usage_percent', value, unit: 'percent',
      status: 'measured', observedAt: recordedAt,
    },
  };
  return {
    id: randomUUID(), recordedAt, value, metrics,
    hash: createHash('sha256')
      .update(JSON.stringify(metrics)).digest('hex'),
  };
}

async function verifyIdentity(db, expected) {
  const r = await db.query(`
    SELECT current_database() AS db, current_user AS role,
      session_user AS session_role,
      inet_server_addr() IS NULL AS socket_only,
      current_setting('port') AS port,
      current_setting('listen_addresses') = '' AS tcp_disabled
  `);
  assert.equal(r.rowCount, 1);
  assert.deepEqual(r.rows[0], {
    db: 'pulse_metrics', role: expected, session_role: expected,
    socket_only: true, port: '55432', tcp_disabled: true,
  });
}

async function expectDenied(promise, label) {
  await assert.rejects(promise, error => {
    assert.equal(error?.code, '42501', `${label}: incorrect SQLSTATE`);
    return true;
  });
}

async function prune(maint) {
  const r = await maint.query(`
    SELECT network_removed, agent_removed
    FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()
  `);
  assert.equal(r.rowCount, 1);
  const n = r.rows[0].network_removed;
  const a = r.rows[0].agent_removed;
  assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= 250);
  assert.ok(Number.isSafeInteger(a) && a >= 0 && a <= 250);
  return { network: n, agent: a };
}

async function consumeNetwork(app, key, client = app) {
  const r = await client.query(`
    SELECT allowed, retry_after_seconds
    FROM pulse_telemetry_quota.consume_network_quota($1::text)
  `, [key]);
  assert.equal(r.rowCount, 1);
  assert.deepEqual(r.rows[0], { allowed: true, retry_after_seconds: 0 });
}

async function issueAndRedeem(app, suffix) {
  const token = secret();
  const credential = secret();
  const expiry = new Date(Date.now() + 600000).toISOString();
  const issued = await app.query(`
    SELECT pulse_agent_enrollment.issue_enrollment(
      $1::text,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz
    ) AS enrollment_id
  `, ['user_agent_owner_a', ORG_A, token.hash, token.prefix,
      `D15C5B synthetic ${suffix}`, expiry]);
  assert.match(issued.rows[0]?.enrollment_id ?? '', UUID);
  const redeemed = await app.query(`
    SELECT * FROM pulse_agent_enrollment.redeem_enrollment(
      $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text
    )
  `, [token.hash, credential.hash, credential.prefix,
      `D15C5B Linux ${suffix}`, `d15c5b-${suffix}.invalid`, 'linux', 'x86_64']);
  assert.equal(redeemed.rowCount, 1);
  assert.equal(redeemed.rows[0].organization_id, ORG_A);
  assert.match(redeemed.rows[0].agent_id, UUID);
  return { credential, agentId: redeemed.rows[0].agent_id };
}

async function ingest(app, credential, item, client = app) {
  const r = await client.query(`
    SELECT pulse_telemetry_ingestion.ingest_submission(
      $1::text,$2::uuid,$3::text,$4::timestamptz,$5::integer,
      $6::real,$7::real,$8::real,$9::bigint,$10::bigint,$11::jsonb
    ) AS outcome
  `, [credential.hash, item.id, item.hash, item.recordedAt,
      1, item.value, null, null, null, null, JSON.stringify(item.metrics)]);
  assert.equal(r.rowCount, 1);
  return r.rows[0].outcome;
}

async function createOldNetwork(fixture, key) {
  await fixture.query(`
    INSERT INTO pulse_telemetry_quota.network_buckets
      (bucket_digest, attempts, window_end)
    VALUES ($1::text, 7, clock_timestamp() - interval '4 days')
  `, [key]);
}

async function createOldAgent(fixture) {
  const orgId = randomUUID();
  const agentId = randomUUID();
  await fixture.query(`
    INSERT INTO pulse_telemetry_agent_quota.agent_buckets
      (organization_id, agent_id, attempts, window_end)
    VALUES ($1::uuid, $2::uuid, 7,
            clock_timestamp() - interval '4 days')
  `, [orgId, agentId]);
  return { orgId, agentId };
}

async function oldCounts(fixture) {
  const r = await fixture.query(`
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
  const app = pool('pulse_metrics_app', 16);
  const maint = pool('pulse_metrics_test_maintainer', 5);
  const fixture = pool('pulse_metrics_test_fixture', 3);
  try {
    stage = 'verify disposable identities and runtime maintenance isolation';
    await Promise.all([
      verifyIdentity(app, 'pulse_metrics_app'),
      verifyIdentity(maint, 'pulse_metrics_test_maintainer'),
      verifyIdentity(fixture, 'pulse_metrics_test_fixture'),
    ]);
    stage = 'ordinary application cannot invoke cleanup';
    await expectDenied(
      app.query('SELECT * FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()'),
      'application invoking cleanup');
    stage = 'ordinary application cannot assume disposable maintenance identity';
    await expectDenied(
      app.query('SET ROLE pulse_metrics_test_maintainer'),
      'application impersonating maintenance login');
    stage = 'maintenance caller cannot delete tables directly';
    await expectDenied(
      maint.query('DELETE FROM pulse_telemetry_quota.network_buckets WHERE false'),
      'maintenance caller directly deleting a bucket');
    stage = 'test fixture cannot invoke maintenance function';
    await expectDenied(
      fixture.query('SELECT * FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()'),
      'fixture caller invoking cleanup');
    stage = 'test fixture can count only explicitly granted bucket key columns';
    assert.deepEqual(await oldCounts(fixture), { network: 0, agent: 0 });
    console.log('PASS: verified isolated peer identities; app/fixture cannot invoke cleanup');

    stage = 'rolled-back cleanup must preserve both expired rows';
    const rollbackKey = networkKey('rollback-network');
    await createOldNetwork(fixture, rollbackKey);
    await createOldAgent(fixture);
    const transactional = await maint.connect();
    let transactionOpen = false;
    try {
      await transactional.query('BEGIN');
      transactionOpen = true;
      assert.deepEqual(await prune(transactional), { network: 1, agent: 1 });
      await transactional.query('ROLLBACK');
      transactionOpen = false;
    } finally {
      if (transactionOpen) await transactional.query('ROLLBACK').catch(() => {});
      transactional.release();
    }
    assert.deepEqual(await oldCounts(fixture), { network: 1, agent: 1 });
    assert.deepEqual(await prune(maint), { network: 1, agent: 1 });
    assert.deepEqual(await oldCounts(fixture), { network: 0, agent: 0 });
    console.log('PASS: interrupted cleanup is atomic; rollback leaves both tables unchanged');

    stage = 'refresh locked, previously expired network and agent buckets';
    const lockKey = networkKey('renew-while-locked');
    const controlKey = networkKey('expired-control');
    await createOldNetwork(fixture, lockKey);
    await createOldNetwork(fixture, controlKey);
    await createOldAgent(fixture);
    const lockedAgent = await issueAndRedeem(app, 'locked-agent');
    const initial = sample(37);
    assert.equal(await ingest(app, lockedAgent.credential, initial), 'inserted');
    await fixture.query(`
      UPDATE pulse_telemetry_agent_quota.agent_buckets
      SET window_end = clock_timestamp() - interval '4 days'
      WHERE organization_id = $1::uuid AND agent_id = $2::uuid
    `, [ORG_A, lockedAgent.agentId]);
    assert.deepEqual(await oldCounts(fixture), { network: 2, agent: 2 });
    const networkHolder = await app.connect();
    const agentHolder = await app.connect();
    let networkOpen = false;
    let agentOpen = false;
    try {
      await networkHolder.query('BEGIN');
      networkOpen = true;
      await consumeNetwork(app, lockKey, networkHolder);
      await agentHolder.query('BEGIN');
      agentOpen = true;
      const renewal = sample(38);
      assert.equal(await ingest(app, lockedAgent.credential, renewal, agentHolder), 'inserted');
      // The app still holds both updated rows until COMMIT; SKIP LOCKED
      // must remove only the unrelated old rows without waiting on them.
      const start = performance.now();
      assert.deepEqual(await prune(maint), { network: 1, agent: 1 });
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 3000, 'cleanup waited on active quota row lock');
      await networkHolder.query('COMMIT');
      networkOpen = false;
      await agentHolder.query('COMMIT');
      agentOpen = false;
      assert.equal(await ingest(app, lockedAgent.credential, renewal), 'duplicate');
    } finally {
      if (networkOpen) await networkHolder.query('ROLLBACK').catch(() => {});
      if (agentOpen) await agentHolder.query('ROLLBACK').catch(() => {});
      networkHolder.release();
      agentHolder.release();
    }
    assert.deepEqual(await oldCounts(fixture), { network: 0, agent: 0 });
    const refreshedNetwork = await fixture.query(`
      SELECT (window_end > clock_timestamp()) AS active, attempts
      FROM pulse_telemetry_quota.network_buckets WHERE bucket_digest = $1::text
    `, [lockKey]);
    assert.equal(refreshedNetwork.rowCount, 1);
    assert.equal(refreshedNetwork.rows[0].active, true);
    assert.equal(Number(refreshedNetwork.rows[0].attempts), 1);
    const refreshedAgent = await fixture.query(`
      SELECT window_end > clock_timestamp() AS active, attempts
      FROM pulse_telemetry_agent_quota.agent_buckets
      WHERE organization_id = $1::uuid AND agent_id = $2::uuid
    `, [ORG_A, lockedAgent.agentId]);
    assert.equal(refreshedAgent.rowCount, 1);
    assert.equal(refreshedAgent.rows[0].active, true);
    assert.equal(Number(refreshedAgent.rows[0].attempts), 1);
    assert.deepEqual(await prune(maint), { network: 0, agent: 0 });
    console.log('PASS: real network and authenticated-agent renewals survive concurrent SKIP LOCKED cleanup');

    stage = 'quota refresh must resume after in-flight cleanup commits';
    // This time cleanup wins the lock, and the two real quota consumers
    // must wait and then recreate fresh buckets; no permanent denial.
    await fixture.query(`
      UPDATE pulse_telemetry_quota.network_buckets
      SET window_end = clock_timestamp() - interval '4 days'
      WHERE bucket_digest = $1::text
    `, [lockKey]);
    await fixture.query(`
      UPDATE pulse_telemetry_agent_quota.agent_buckets
      SET window_end = clock_timestamp() - interval '4 days'
      WHERE organization_id = $1::uuid AND agent_id = $2::uuid
    `, [ORG_A, lockedAgent.agentId]);
    const deleting = await maint.connect();
    let deletingOpen = false;
    try {
      await deleting.query('BEGIN');
      deletingOpen = true;
      assert.deepEqual(await prune(deleting), { network: 1, agent: 1 });
      const networkWaiter = await app.connect();
      const agentWaiter = await app.connect();
      try {
        let networkFinished = false;
        let agentFinished = false;
        const pendingNetwork = consumeNetwork(app, lockKey, networkWaiter)
          .then(() => { networkFinished = true; });
        const pendingAgent = ingest(app, lockedAgent.credential, sample(39), agentWaiter)
          .then(result => { agentFinished = true; return result; });
        // Both clients are already connected, so the queries are sent while
        // the maintainer is holding uncommitted DELETE locks.
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(networkFinished, false, 'network consume bypassed uncommitted cleanup');
        assert.equal(agentFinished, false, 'agent ingestion bypassed uncommitted cleanup');
        await deleting.query('COMMIT');
        deletingOpen = false;
        const [networkResult, agentResult] = await Promise.all([pendingNetwork, pendingAgent]);
        assert.equal(networkResult, undefined);
        assert.equal(agentResult, 'inserted');
      } finally {
        networkWaiter.release();
        agentWaiter.release();
      }
    } finally {
      if (deletingOpen) await deleting.query('ROLLBACK').catch(() => {});
      deleting.release();
    }
    assert.deepEqual(await oldCounts(fixture), { network: 0, agent: 0 });
    const restored = await fixture.query(`
      SELECT
        (SELECT window_end > clock_timestamp()
         FROM pulse_telemetry_quota.network_buckets
         WHERE bucket_digest = $1::text) AS network_active,
        (SELECT window_end > clock_timestamp()
         FROM pulse_telemetry_agent_quota.agent_buckets
         WHERE organization_id = $2::uuid AND agent_id = $3::uuid) AS agent_active
    `, [lockKey, ORG_A, lockedAgent.agentId]);
    assert.deepEqual(restored.rows[0], { network_active: true, agent_active: true });
    console.log('PASS: real quota consumers wait for in-flight cleanup then recreate active buckets');

    stage = 'SKIP LOCKED must leave a still-expired row until lock release';
    const blockedKey = networkKey('held-expired-unrenewed');
    await createOldNetwork(fixture, blockedKey);
    const lockOwner = await fixture.connect();
    let lockOpen = false;
    try {
      await lockOwner.query('BEGIN');
      lockOpen = true;
      const row = await lockOwner.query(`
        SELECT bucket_digest
        FROM pulse_telemetry_quota.network_buckets
        WHERE bucket_digest = $1::text
        FOR UPDATE
      `, [blockedKey]);
      assert.equal(row.rowCount, 1);
      assert.deepEqual(await prune(maint), { network: 0, agent: 0 });
      await lockOwner.query('COMMIT');
      lockOpen = false;
    } finally {
      if (lockOpen) await lockOwner.query('ROLLBACK').catch(() => {});
      lockOwner.release();
    }
    assert.deepEqual(await prune(maint), { network: 1, agent: 0 });
    assert.deepEqual(await oldCounts(fixture), { network: 0, agent: 0 });
    console.log('PASS: locked expired bucket skipped promptly, then removed after release');

    stage = 'multiple maintenance workers versus real concurrent ingestion';
    const busyAgent = await issueAndRedeem(app, 'parallel-load');
    await fixture.query(`
      INSERT INTO pulse_telemetry_quota.network_buckets
        (bucket_digest, attempts, window_end)
      SELECT encode(sha256(convert_to('pulse-d15c5b-bulk-network-' || g.n,
                 'UTF8')), 'hex'), 7,
             clock_timestamp() - interval '4 days'
      FROM generate_series(1, 525) AS g(n)
    `);
    await fixture.query(`
      INSERT INTO pulse_telemetry_agent_quota.agent_buckets
        (organization_id, agent_id, attempts, window_end)
      SELECT gen_random_uuid(), gen_random_uuid(), 7,
             clock_timestamp() - interval '4 days'
      FROM generate_series(1, 525)
    `);
    assert.deepEqual(await oldCounts(fixture), { network: 525, agent: 525 });
    const requests = Array.from({ length: 80 }, (_, i) => sample((i % 70) + 10));
    const tasks = [
      ...Array.from({ length: 4 }, () => prune(maint)),
      ...requests.map(item => ingest(app, busyAgent.credential, item)),
    ];
    const results = await Promise.all(tasks);
    const batches = results.slice(0, 4);
    assert.equal(batches.reduce((a, b) => a + b.network, 0), 525);
    assert.equal(batches.reduce((a, b) => a + b.agent, 0), 525);
    assert.deepEqual(results.slice(4), Array(80).fill('inserted'));
    assert.deepEqual(await oldCounts(fixture), { network: 0, agent: 0 });
    const loadBucket = await fixture.query(`
      SELECT attempts, window_end > clock_timestamp() AS active
      FROM pulse_telemetry_agent_quota.agent_buckets
      WHERE organization_id = $1::uuid AND agent_id = $2::uuid
    `, [ORG_A, busyAgent.agentId]);
    assert.equal(loadBucket.rowCount, 1);
    assert.equal(Number(loadBucket.rows[0].attempts), 80);
    assert.equal(loadBucket.rows[0].active, true);
    assert.deepEqual(await prune(maint), { network: 0, agent: 0 });
    console.log('PASS: four concurrent cleanup workers removed 525/525 old rows; 80 live ingests persisted');

    console.log('D15C-5B DISPOSABLE POSTGRESQL CONTENTION TESTS PASSED');
  } finally {
    await Promise.allSettled([app.end(), maint.end(), fixture.end()]);
  }
}

main().catch(error => {
  // Sensitive SQL, raw credentials, connection strings and parameters
  // are intentionally omitted from test diagnostics.
  console.error('REFUSE_D15C5B_INTEGRATION: stage=' + stage);
  console.error('ERROR CATEGORY:',
    typeof error?.code === 'string' ? error.code : error?.name ?? 'unknown');
  if (error?.name === 'AssertionError') console.error('ASSERTION:', error.message);
  process.exitCode = 1;
});
