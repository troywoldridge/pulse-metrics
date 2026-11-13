/**
 * Pulse Metrics D15C-3C — isolated PostgreSQL quota checks.
 * Test data: synthetic HMAC-shaped digests only. No network listener.
 * Never use a real customer DB or DATABASE_URL.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const socket = process.env.PULSE_TELEMETRY_QUOTA_SOCKET;
const data = process.env.PULSE_TELEMETRY_QUOTA_DATA;
const mode = process.argv[2] ?? '--normal';

function guard() {
  assert.equal(process.env.PULSE_TELEMETRY_QUOTA_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.ok(mode === '--normal' || mode === '--rollover');
  assert.match(socket ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(data, `${dirname(socket)}/data`);
  const marker = `${dirname(socket)}/.pulse-telemetry-quota-marker`;
  assert.ok(existsSync(marker));
  assert.ok(lstatSync(marker).isFile());
  assert.equal(lstatSync(marker).isSymbolicLink(), false);
}

const digest = letter => letter.repeat(64);

async function main() {
  guard();
  const pool = new Pool({
    host: socket,
    port: 55432,
    database: 'pulse_metrics',
    user: 'pulse_metrics_app',
    ssl: false,
    max: 12,
    connectionTimeoutMillis: 3000,
    statement_timeout: 8000,
    application_name: 'pulse-telemetry-quota-disposable-test',
  });

  try {
    const identity = (await pool.query(`
      SELECT current_database() AS db, current_user AS role,
             inet_server_addr() IS NULL AS socket_only
    `)).rows[0];
    assert.deepEqual(identity, {
      db: 'pulse_metrics', role: 'pulse_metrics_app', socket_only: true,
    });

    const consume = async value => {
      const result = await pool.query(`
        SELECT allowed, retry_after_seconds
        FROM pulse_telemetry_quota.consume_network_quota($1)
      `, [value]);
      assert.equal(result.rows.length, 1);
      const row = result.rows[0];
      assert.equal(typeof row.allowed, 'boolean');
      assert.ok(Number.isInteger(row.retry_after_seconds));
      return row;
    };

    if (mode === '--rollover') {
      const result = await consume(digest('a'));
      assert.deepEqual(result, { allowed: true, retry_after_seconds: 0 });
      console.log('PASS: expired quota window resets on restricted runtime request');
      return;
    }

    for (const statement of [
      'SELECT * FROM pulse_telemetry_quota.network_buckets LIMIT 1',
      'SELECT * FROM pulse_telemetry_quota.schema_migrations LIMIT 1',
      `INSERT INTO pulse_telemetry_quota.network_buckets
        (bucket_digest, attempts, window_end)
        VALUES ('${digest('f')}', 1, clock_timestamp())`,
      `UPDATE pulse_telemetry_quota.network_buckets
        SET attempts = 1 WHERE bucket_digest = '${digest('a')}'`,
      `DELETE FROM pulse_telemetry_quota.network_buckets
        WHERE bucket_digest = '${digest('a')}'`,
    ]) {
      await assert.rejects(pool.query(statement), error => error?.code === '42501');
    }
    const ownership = (await pool.query(`
      SELECT pg_has_role(current_user, 'pulse_metrics_telemetry_quota_executor', 'MEMBER') AS member
    `)).rows[0];
    assert.equal(ownership.member, false);
    console.log('PASS: restricted runtime cannot read/write quota tables or assume owner role');

    for (const invalid of ['', 'x', 'A'.repeat(64), 'a'.repeat(63)]) {
      await assert.rejects(consume(invalid), error => error?.code === '22023');
    }
    console.log('PASS: invalid HMAC-shaped digests refused by database function');

    for (let i = 1; i <= 1201; i++) {
      const result = await consume(digest('a'));
      assert.equal(result.allowed, i <= 1200, `sequential attempt ${i}`);
      assert.equal(result.retry_after_seconds === 0, i <= 1200);
      if (i === 1201) {
        assert.ok(result.retry_after_seconds >= 1);
        assert.ok(result.retry_after_seconds <= 60);
      }
    }
    console.log('PASS: 1200/60-second ceiling enforced; attempt 1201 rejected');

    const concurrent = await Promise.all(
      Array.from({ length: 1224 }, () => consume(digest('b'))),
    );
    assert.equal(concurrent.filter(row => row.allowed).length, 1200);
    assert.equal(concurrent.filter(row => !row.allowed).length, 24);
    console.log('PASS: 1224 concurrent calls: exactly 1200 admitted, 24 denied');

    assert.deepEqual(await consume(digest('c')), {
      allowed: true, retry_after_seconds: 0,
    });
    console.log('PASS: independent network identifiers have separate counters');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('REFUSE_D15C_QUOTA_TEST:', error?.message ?? 'unknown');
  process.exitCode = 1;
});
