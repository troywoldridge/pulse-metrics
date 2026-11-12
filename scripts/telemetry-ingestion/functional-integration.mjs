/**
 * Pulse Metrics D15B — PostgreSQL functional integration.
 *
 * Synthetic organizations and credentials only.
 * Disposable Unix-socket cluster only.
 *
 * Each operation is labeled for safe failure diagnosis.
 * Never print credentials, hashes, SQL parameters or driver errors.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const { Client } = pg;

const SOCKET = process.env.PULSE_AGENT_SOCKET;
const DATA = process.env.PULSE_AGENT_DATA;
const ORG_A = process.env.PULSE_AGENT_ORG_A;
const ORG_B = process.env.PULSE_AGENT_ORG_B;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let currentStage = 'startup';

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

  assert.match(ORG_A ?? '', UUID);
  assert.match(ORG_B ?? '', UUID);
  assert.notEqual(ORG_A, ORG_B);
}

function secret() {
  const raw = randomBytes(32).toString('base64url');

  const hash = createHash('sha256')
    .update(raw, 'utf8')
    .digest('hex');

  return {
    hash,
    prefix: hash.slice(0, 12),
  };
}

async function stage(name, operation) {
  currentStage = name;

  const result = await operation();

  console.log(`PASS: ${name}`);

  return result;
}

async function open() {
  guard();

  const client = new Client({
    host: SOCKET,
    port: 55432,
    user: 'pulse_metrics_app',
    database: 'pulse_metrics',
    ssl: false,
    connectionTimeoutMillis: 2500,
    statement_timeout: 6000,
    application_name: 'pulse-d15b-synthetic-test',
  });

  await client.connect();

  try {
    // The disposable-cluster launcher has already verified
    // data_directory as postgres. Never grant that privileged
    // setting to the ordinary application role.
    const result = await client.query(`
      SELECT current_database() AS db,
             current_user AS role,
             session_user AS session_role,
             inet_server_addr() IS NULL AS socket_only,
             current_setting('port') AS server_port
    `);

    const identity = result.rows[0];

    assert.equal(result.rowCount, 1);
    assert.equal(identity.db, 'pulse_metrics');
    assert.equal(identity.role, 'pulse_metrics_app');
    assert.equal(identity.session_role, 'pulse_metrics_app');
    assert.equal(identity.socket_only, true);
    assert.equal(identity.server_port, '55432');

    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

async function issueAndRedeem(
  client,
  subject,
  organizationId,
  suffix,
) {
  const token = secret();
  const credential = secret();

  const expiry = new Date(
    Date.now() + 10 * 60 * 1000,
  ).toISOString();

  const issued = await stage(
    `${suffix}: issue enrollment`,
    () => client.query(`
      SELECT pulse_agent_enrollment.issue_enrollment(
        $1::text, $2::uuid, $3::text, $4::text,
        $5::text, $6::timestamptz
      ) AS enrollment_id
    `, [
      subject,
      organizationId,
      token.hash,
      token.prefix,
      `D15B synthetic agent ${suffix}`,
      expiry,
    ]),
  );

  assert.match(issued.rows[0]?.enrollment_id ?? '', UUID);

  const redeemed = await stage(
    `${suffix}: redeem enrollment`,
    () => client.query(`
      SELECT * FROM pulse_agent_enrollment.redeem_enrollment(
        $1::text, $2::text, $3::text, $4::text,
        $5::text, $6::text, $7::text
      )
    `, [
      token.hash,
      credential.hash,
      credential.prefix,
      `D15B synthetic Linux ${suffix}`,
      `d15b-${suffix}.invalid`,
      'linux',
      'x86_64',
    ]),
  );

  assert.equal(redeemed.rowCount, 1);
  assert.equal(
    redeemed.rows[0].organization_id,
    organizationId,
  );
  assert.match(redeemed.rows[0].agent_id, UUID);

  return {
    credential,
    agentId: redeemed.rows[0].agent_id,
  };
}

function submission(value = 42) {
  const recordedAt = new Date().toISOString();

  const metrics = {
    'cpu.usage_percent': {
      metric: 'cpu.usage_percent',
      value,
      unit: 'percent',
      status: 'measured',
      observedAt: recordedAt,
    },
  };

  return {
    id: randomUUID(),
    fingerprint: createHash('sha256')
      .update(JSON.stringify(metrics))
      .digest('hex'),
    recordedAt,
    cpu: value,
    metrics,
  };
}

async function ingest(client, credential, item) {
  const response = await client.query(`
    SELECT pulse_telemetry_ingestion.ingest_submission(
      $1::text,
      $2::uuid,
      $3::text,
      $4::timestamptz,
      $5::integer,
      $6::real,
      $7::real,
      $8::real,
      $9::bigint,
      $10::bigint,
      $11::jsonb
    ) AS outcome
  `, [
    credential.hash,
    item.id,
    item.fingerprint,
    item.recordedAt,
    1,
    item.cpu,
    null,
    null,
    null,
    null,
    JSON.stringify(item.metrics),
  ]);

  assert.equal(response.rowCount, 1);

  return response.rows[0].outcome;
}

async function denied(task, expectedCode, label) {
  let caught;

  try {
    await task();
  } catch (error) {
    caught = error;
  }

  assert.ok(
    caught,
    `${label}: operation unexpectedly succeeded`,
  );

  assert.equal(
    caught.code,
    expectedCode,
    `${label}: unexpected SQLSTATE`,
  );
}

async function main() {
  guard();

  const client = await stage(
    'restricted application connection',
    open,
  );

  try {
    const a = await issueAndRedeem(
      client,
      'user_agent_owner_a',
      ORG_A,
      'a',
    );

    const b = await issueAndRedeem(
      client,
      'user_agent_owner_b',
      ORG_B,
      'b',
    );

    const first = submission(42);

    assert.equal(
      await stage(
        'tenant A: first telemetry insert',
        () => ingest(client, a.credential, first),
      ),
      'inserted',
    );

    assert.equal(
      await stage(
        'tenant A: identical retry',
        () => ingest(client, a.credential, first),
      ),
      'duplicate',
    );

    const changedMetrics = {
      'cpu.usage_percent': {
        ...first.metrics['cpu.usage_percent'],
        value: 43,
      },
    };

    const changed = {
      ...first,
      cpu: 43,
      metrics: changedMetrics,
      fingerprint: createHash('sha256')
        .update(JSON.stringify(changedMetrics))
        .digest('hex'),
    };

    assert.equal(
      await stage(
        'tenant A: conflicting retry',
        () => ingest(client, a.credential, changed),
      ),
      'conflict',
    );

    assert.equal(
      await stage(
        'tenant B: independent submission',
        () => ingest(client, b.credential, first),
      ),
      'inserted',
    );

    await stage(
      'unknown machine credential denied',
      () => denied(
        () => ingest(client, secret(), submission()),
        '42501',
        'unknown machine credential',
      ),
    );

    const malformed = submission();

    malformed.metrics['cpu.usage_percent'] = {
      metric: 'cpu.usage_percent',
      value: 42,
      unit: 'percent',
      observedAt: malformed.recordedAt,
    };

    await stage(
      'missing metric status denied by PostgreSQL',
      () => denied(
        () => ingest(client, a.credential, malformed),
        '22023',
        'missing metric status',
      ),
    );

    await stage(
      'ordinary application denied private ledger access',
      () => denied(
        () => client.query(
          'SELECT * FROM pulse_telemetry_ingestion.submissions',
        ),
        '42501',
        'private ledger access',
      ),
    );

    const revoked = await stage(
      'tenant A: administrator revokes agent',
      () => client.query(`
        SELECT pulse_agent_enrollment.revoke_agent(
          $1::text, $2::uuid, $3::uuid
        ) AS revoked
      `, [
        'user_agent_owner_a',
        ORG_A,
        a.agentId,
      ]),
    );

    assert.equal(revoked.rows[0]?.revoked, true);

    await stage(
      'revoked credential cannot retry',
      () => denied(
        () => ingest(client, a.credential, first),
        '42501',
        'revoked credential retry',
      ),
    );

    await stage(
      'revoked credential cannot insert new telemetry',
      () => denied(
        () => ingest(client, a.credential, submission()),
        '42501',
        'revoked credential new submission',
      ),
    );

    console.log(
      'D15B FUNCTIONAL POSTGRESQL REHEARSAL PASSED',
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // Print only the stage and safe error category, never the
  // database driver's detailed message or parameters.
  const code =
    typeof error?.code === 'string'
      ? error.code
      : error?.name ?? 'unknown-error';

  console.error(
    'D15B FUNCTIONAL REHEARSAL FAILED',
  );

  console.error(
    `FAILED STAGE: ${currentStage}`,
  );

  console.error(
    `ERROR CATEGORY: ${code}`,
  );

  if (
    error?.name === 'AssertionError' &&
    typeof error.message === 'string'
  ) {
    console.error(
      `ASSERTION: ${error.message}`,
    );
  }

  process.exitCode = 1;
});
