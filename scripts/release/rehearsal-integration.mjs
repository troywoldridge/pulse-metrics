// Phase 2E3C5D3: exercise signed approval + session advisory lock + atomic
// synthetic migration receipt. ALL database writes are on a marked,
// explicitly verified, Unix-only disposable PostgreSQL cluster.
// Not a production release executor. Never reads DATABASE_URL.
import pg from 'pg';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyManifest } from '../migrations/verify-manifest.mjs';
import {
  LOCK_KEYS, CATALOG_SHA256, MIGRATION_SHA256,
  approvalMessage, planDigest, reviewedMigrationSql, reviewedPlan,
  sha256, verifyApprovals,
} from './release-policy.mjs';

const { Client } = pg;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOCKET = process.env.PULSE_RELEASE_SOCKET;
const DATA = process.env.PULSE_RELEASE_DATA;
const PORT = 55432;

function insist(ok, detail) {
  if (!ok) throw Error(`REFUSE_RELEASE: ${detail}`);
}

function ensureDisposableTarget() {
  insist(process.env.PULSE_RELEASE_DISPOSABLE_ONLY === 'YES', 'explicit test-only marker missing');
  insist(typeof SOCKET === 'string' && /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/.test(SOCKET),
    'socket is not an approved random disposable location');
  insist(DATA === `${dirname(SOCKET)}/data`, 'PostgreSQL data-directory path not matched');
  const marker = `${dirname(SOCKET)}/.pulse-release-lock-marker`;
  insist(existsSync(marker) && lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink(),
    'disposable cluster identity marker missing');
  insist(process.env.NODE_ENV !== 'production', 'production execution forbidden');
}

function config() {
  ensureDisposableTarget();
  return {
    host: SOCKET,
    port: PORT,
    database: 'pulse_metrics',
    user: 'pulse_metrics_migrator',
    password: undefined,
    ssl: false,
    connectionTimeoutMillis: 2500,
    statement_timeout: 5000,
    application_name: 'pulse-release-synthetic-rehearsal',
  };
}

function newClient() { return new Client(config()); }

async function verifiedConnection(client) {
  // The root shell harness already verified data_directory, listen_addresses,
  // data-dir ownership and the isolated Unix socket with the POSTGRES admin.
  // The normal migrator has no pg_read_all_settings privilege by design;
  // never grant it merely to let this test read privileged settings.
  const r = await client.query(`SELECT current_database() AS db,
    current_user AS role, session_user AS session_role,
    inet_server_addr() IS NULL AS unix_only,
    inet_server_port() IS NULL AS unix_port`);
  const v = r.rows[0];
  insist(r.rowCount === 1 && v.db === 'pulse_metrics' &&
    v.role === 'pulse_metrics_migrator' &&
    v.session_role === 'pulse_metrics_migrator' &&
    v.unix_only === true && v.unix_port === true,
    'database identity is not the disposable migrator Unix-only cluster');
}

const CATALOG_SQL = readFileSync(resolve(ROOT, 'scripts/replay/catalog-manifest.sql'), 'utf8')
  .split('\n')
  .filter(line => !/^\s*\\set\b/.test(line) &&
    !/^\s*BEGIN READ ONLY;\s*$/.test(line) &&
    !/^\s*COMMIT;\s*$/.test(line))
  .join('\n');

async function preflight(client) {
  verifyManifest(ROOT);
  reviewedMigrationSql();
  const baseline = await client.query('SELECT pulse_release_rehearsal.reviewed_baseline_ok() AS ok');
  insist(baseline.rows.length === 1 && baseline.rows[0].ok === true,
    'Drizzle history or six privileged migration receipts differ');
  const catalog = await client.query(CATALOG_SQL);
  const lines = catalog.rows.map(row => row.line);
  insist(lines.length > 50 && sha256(Buffer.from(`${lines.join('\n')}\n`)) === CATALOG_SHA256,
    'public schema/RLS/privilege fingerprint differs from reviewed baseline');
}

async function tryLock(client) {
  const r = await client.query(
    'SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired', LOCK_KEYS,
  );
  return r.rows[0]?.acquired === true;
}

async function unlock(client) {
  const r = await client.query(
    'SELECT pg_advisory_unlock($1::integer,$2::integer) AS released', LOCK_KEYS,
  );
  insist(r.rows[0]?.released === true, 'release session lock was not held on unlock');
}

export async function attemptRelease({ plan, approvals, trustedKeys, failAfterDdl = false, clientFactory = newClient }) {
  // No socket, connection or DB operation is touched until verification passes.
  const verified = verifyApprovals(plan, approvals, trustedKeys);
  ensureDisposableTarget();
  const client = clientFactory();
  let connected = false;
  let locked = false;
  let transaction = false;
  try {
    await client.connect();
    connected = true;
    await verifiedConnection(client);
    await preflight(client); // independent read-only preflight BEFORE lock
    locked = await tryLock(client);
    insist(locked, 'LOCK_BUSY: another release session holds the advisory lock');
    await preflight(client); // revalidate catalog, SQL, ledger WHILE holding lock
    const existing = await client.query(
      'SELECT plan_sha256 FROM pulse_release_rehearsal.release_receipts WHERE release_id=$1',
      [plan.releaseId],
    );
    insist(existing.rowCount === 0, 'ALREADY_APPLIED: immutable release id already has a receipt');
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '1500ms'");
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query(reviewedMigrationSql());
    if (failAfterDdl) {
      // Deliberate SQL ERROR after CREATE TABLE + INSERT, before receipt.
      // PostgreSQL must roll back the entire transaction.
      await client.query('SELECT 1/0');
    }
    await client.query(`INSERT INTO pulse_release_rehearsal.release_receipts
      (release_id, plan_sha256, migration_sha256, operator_subject,
       operator_key_id, reviewer_subject, reviewer_key_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      plan.releaseId, verified.digest, MIGRATION_SHA256,
      verified.operator.subject, verified.operator.keyId,
      verified.reviewer.subject, verified.reviewer.keyId,
    ]);
    await client.query('COMMIT');
    transaction = false;
    return { outcome: 'applied', releaseId: plan.releaseId, planSha256: verified.digest };
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); }
      catch { /* connection may have died; PostgreSQL aborts open transaction on disconnect */ }
    }
    throw error;
  } finally {
    if (connected) {
      try { if (locked) await unlock(client); }
      finally { await client.end(); }
    }
  }
}

function testApprovals() {
  const ids = [
    { keyId: 'synthetic-operator-1', subject: 'isolated-test-operator', role: 'operator' },
    { keyId: 'synthetic-reviewer-1', subject: 'isolated-test-reviewer', role: 'reviewer' },
  ];
  const trusted = new Map();
  const approvals = [];
  const now = Date.now();
  const plan = reviewedPlan();
  for (const identity of ids) {
    // Keys are created only in this test process; never exported or committed.
    const keys = generateKeyPairSync('ed25519');
    trusted.set(identity.keyId, { publicKey: keys.publicKey, role: identity.role, subject: identity.subject });
    const approval = {
      planSha256: planDigest(plan),
      keyId: identity.keyId,
      subject: identity.subject,
      role: identity.role,
      issuedAt: new Date(now - 5000).toISOString(),
      expiresAt: new Date(now + 120000).toISOString(),
    };
    approvals.push({ ...approval, signature: signMessage(null, approvalMessage(approval), keys.privateKey).toString('base64') });
  }
  return { plan, approvals, trusted };
}

async function fixtureState(client) {
  const r = await client.query(`SELECT
    (SELECT count(*)::integer FROM pulse_release_rehearsal.release_receipts) AS receipts,
    (to_regclass('pulse_release_rehearsal.applied_canary') IS NOT NULL) AS has_canary`);
  return r.rows[0];
}

function expectFailure(test, text) {
  return test().then(
    () => { throw Error(`TEST_FAILED: expected rejection ${text}`); },
    error => {
      insist(String(error.message).includes(text), `wrong rejection: ${error.message}`);
    },
  );
}

async function main() {
  ensureDisposableTarget();
  reviewedMigrationSql();
  const { plan, approvals, trusted } = testApprovals();
  const neverOpen = () => { throw Error('TEST_FAILED: rejected approval reached DB client factory'); };
  await expectFailure(() => attemptRelease({ plan, approvals: approvals.slice(0, 1), trustedKeys: trusted, clientFactory: neverOpen }),
    'exactly two independent approvals');
  const forged = structuredClone(approvals);
  forged[1].planSha256 = '0'.repeat(64);
  await expectFailure(() => attemptRelease({ plan, approvals: forged, trustedKeys: trusted, clientFactory: neverOpen }),
    'different release plan');
  console.log('PASS: missing/forged approval rejected before any DB connection');

  const holder = newClient();
  await holder.connect();
  await verifiedConnection(holder);
  await preflight(holder);
  insist(await tryLock(holder), 'test holder failed to acquire session advisory lock');
  await expectFailure(() => attemptRelease({ plan, approvals, trustedKeys: trusted }), 'LOCK_BUSY');
  let state = await fixtureState(holder);
  insist(state.receipts === 0 && !state.has_canary, 'contender wrote despite lock');
  console.log('PASS: competing release refused under existing advisory lock, no migration executed');
  await holder.end(); // simulate a dropped session; server automatically frees lock

  const afterDrop = newClient();
  await afterDrop.connect();
  await verifiedConnection(afterDrop);
  insist(await tryLock(afterDrop), 'advisory lock not released after session ended');
  await unlock(afterDrop);
  await afterDrop.end();
  console.log('PASS: session disconnect automatically releases the advisory lock');

  await expectFailure(() => attemptRelease({ plan, approvals, trustedKeys: trusted, failAfterDdl: true }),
    'division by zero');
  const observer = newClient();
  await observer.connect();
  await verifiedConnection(observer);
  state = await fixtureState(observer);
  insist(state.receipts === 0 && !state.has_canary,
    'failed transaction leaked DDL/data or forged a successful release receipt');
  await observer.end();
  console.log('PASS: injected post-DDL SQL failure rolled back schema, rows AND release receipt');

  const successful = await attemptRelease({ plan, approvals, trustedKeys: trusted });
  insist(successful.outcome === 'applied', 'approved release did not commit');
  const inspect = newClient();
  await inspect.connect();
  await verifiedConnection(inspect);
  state = await fixtureState(inspect);
  insist(state.receipts === 1 && state.has_canary, 'release DDL/receipt did not commit atomically');
  const row = await inspect.query(`SELECT r.release_id, r.plan_sha256,
    r.migration_sha256, r.operator_subject, r.reviewer_subject, c.description
    FROM pulse_release_rehearsal.release_receipts r
    CROSS JOIN pulse_release_rehearsal.applied_canary c`);
  insist(row.rows.length === 1 && row.rows[0].plan_sha256 === planDigest(plan) &&
    row.rows[0].migration_sha256 === MIGRATION_SHA256 &&
    row.rows[0].operator_subject !== row.rows[0].reviewer_subject &&
    row.rows[0].description === 'synthetic approved release',
    'release receipt contents or test DDL are incorrect');
  await preflight(inspect); // public catalog and historical receipts still unchanged
  await inspect.end();
  console.log('PASS: approved release committed one synthetic migration with bound, auditable receipt');

  await expectFailure(() => attemptRelease({ plan, approvals, trustedKeys: trusted }), 'ALREADY_APPLIED');
  console.log('PASS: duplicate release id rejected; migration never re-executed');
  console.log('========== ISOLATED RELEASE LOCKING AND APPROVAL REHEARSAL COMPLETED ==========');
  console.log('NOTE: synthetic local signers/keys only; not production authorization, audit storage or deployment');
}

main().catch(error => {
  console.error(error?.message ?? 'Release rehearsal failed');
  process.exitCode = 1;
});
