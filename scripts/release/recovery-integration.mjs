// Phase 2E3C5D4: interruption and uncertain-outcome rehearsal ONLY.
// No DATABASE_URL. No actual user data. Requires a shell-verified disposable
// PostgreSQL cluster, a Unix socket and non-superuser migrator identity.
import pg from 'pg';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyManifest } from '../migrations/verify-manifest.mjs';
import {
  approvalMessage, CATALOG_SHA256, LOCK_KEYS, MIGRATION_SHA256,
  planDigest, reviewedMigrationSql, reviewedPlan, sha256, verifyApprovals,
} from './release-policy.mjs';
import { decideRecovery, RECOVERY } from './recovery-decision.mjs';

const { Client } = pg;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOCKET = process.env.PULSE_RELEASE_SOCKET;
const DATA = process.env.PULSE_RELEASE_DATA;
const PORT = 55432;

function insist(ok, reason) {
  if (!ok) throw new Error(`REFUSE_RECOVERY: ${reason}`);
}
function guard() {
  insist(process.env.PULSE_RELEASE_DISPOSABLE_ONLY === 'YES', 'test-only authorization missing');
  insist(typeof SOCKET === 'string' && /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/.test(SOCKET),
    'socket is not a random isolated test directory');
  insist(DATA === `${dirname(SOCKET)}/data`, 'data/socket path mismatch');
  const marker = `${dirname(SOCKET)}/.pulse-release-lock-marker`;
  insist(existsSync(marker) && lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink(),
    'disposable cluster marker missing');
  insist(process.env.NODE_ENV !== 'production', 'production execution denied');
}
function newClient() {
  guard();
  const client = new Client({ host: SOCKET, port: PORT, database: 'pulse_metrics',
    user: 'pulse_metrics_migrator', password: undefined, ssl: false,
    connectionTimeoutMillis: 2500, statement_timeout: 5000,
    application_name: 'pulse-failure-recovery-test' });
  // A backend intentionally terminated by our negative test can emit an async
  // node-postgres connection error; the test handles it as expected evidence.
  client.on('error', () => {});
  return client;
}
async function connectVerified() {
  const client = newClient();
  await client.connect();
  try {
    const r = await client.query(`SELECT current_user AS role, session_user AS session_role,
      current_database() AS db, inet_server_addr() IS NULL AS unix_only,
      inet_server_port() IS NULL AS unix_port`);
    const v = r.rows[0];
    insist(r.rowCount === 1 && v.role === 'pulse_metrics_migrator' &&
      v.session_role === 'pulse_metrics_migrator' && v.db === 'pulse_metrics' &&
      v.unix_only === true && v.unix_port === true, 'migrator/socket identity incorrect');
    return client;
  } catch (error) { await client.end().catch(() => {}); throw error; }
}
const CATALOG_SQL = readFileSync(resolve(ROOT, 'scripts/replay/catalog-manifest.sql'), 'utf8')
  .split('\n')
  .filter(line => !/^\s*\\set\b/.test(line) &&
    !/^\s*BEGIN READ ONLY;\s*$/.test(line) && !/^\s*COMMIT;\s*$/.test(line))
  .join('\n');
async function preflight(client) {
  verifyManifest(ROOT);
  reviewedMigrationSql();
  const ledger = await client.query('SELECT pulse_release_rehearsal.reviewed_baseline_ok() AS ok');
  insist(ledger.rows.length === 1 && ledger.rows[0].ok === true,
    'historical privileged receipts/Drizzle history mismatch');
  const catalog = await client.query(CATALOG_SQL);
  const lines = catalog.rows.map(r => r.line);
  insist(lines.length > 50 && sha256(Buffer.from(`${lines.join('\n')}\n`)) === CATALOG_SHA256,
    'original public security fingerprint mismatch');
}
async function takeLock(client) {
  const r = await client.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) AS locked', LOCK_KEYS);
  return r.rows[0]?.locked === true;
}
async function releaseLock(client) {
  const r = await client.query('SELECT pg_advisory_unlock($1::integer,$2::integer) AS released', LOCK_KEYS);
  insist(r.rows[0]?.released === true, 'session lock not held on unlock');
}
function signedApprovals() {
  const plan = reviewedPlan();
  const now = Date.now();
  const trustedKeys = new Map();
  const approvals = [];
  for (const spec of [
    { role: 'operator', keyId: 'recovery-operator-1', subject: 'synthetic-recovery-operator' },
    { role: 'reviewer', keyId: 'recovery-reviewer-1', subject: 'synthetic-recovery-reviewer' },
  ]) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    trustedKeys.set(spec.keyId, { publicKey, role: spec.role, subject: spec.subject });
    const fields = { planSha256: planDigest(plan), keyId: spec.keyId,
      subject: spec.subject, role: spec.role, issuedAt: new Date(now - 2000).toISOString(),
      expiresAt: new Date(now + 120_000).toISOString() };
    approvals.push({ ...fields, signature: signMessage(null, approvalMessage(fields), privateKey).toString('base64') });
  }
  verifyApprovals(plan, approvals, trustedKeys); // pre-connect validation
  return { plan, approvals, trustedKeys };
}
async function readEvidence(client) {
  // Entire release receipt relation is read, not just the expected release ID.
  // Unexpected extra receipts must quarantine rather than be misread as absence.
  const receipts = await client.query(`SELECT release_id, plan_sha256, migration_sha256,
      operator_subject, reviewer_subject FROM pulse_release_rehearsal.release_receipts ORDER BY release_id`);
  let receipt = null;
  if (receipts.rows.length) receipt = { ...receipts.rows[0], total_receipts: receipts.rows.length };
  const exists = await client.query(`SELECT to_regclass('pulse_release_rehearsal.applied_canary') IS NOT NULL AS present`);
  let canary = null;
  if (exists.rows[0]?.present === true) {
    const rows = await client.query('SELECT id, description FROM pulse_release_rehearsal.applied_canary ORDER BY id');
    canary = { ...(rows.rows[0] ?? {}), total_canary: rows.rows.length };
  }
  return { receipt, canary };
}
async function decideUnderLock(client, plan) {
  await preflight(client);
  insist(await takeLock(client), 'LOCK_BUSY: stop; never reconcile without the lock');
  try {
    // The second check is WITH the cooperative lock held.
    await preflight(client);
    const evidence = await readEvidence(client);
    return decideRecovery({ plan, lockHeld: true, baselineVerified: true, ...evidence });
  } finally {
    await releaseLock(client);
  }
}
async function runAbortedBackend({ plan, approvals, trustedKeys }) {
  verifyApprovals(plan, approvals, trustedKeys);
  const holder = await connectVerified();
  let killer;
  try {
    await preflight(holder);
    insist(await takeLock(holder), 'failed to hold release lock for interrupted transaction');
    await preflight(holder);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('BEGIN');
    await holder.query("SET LOCAL lock_timeout = '1500ms'");
    await holder.query("SET LOCAL statement_timeout = '4000ms'");
    await holder.query(reviewedMigrationSql());
    const verified = verifyApprovals(plan, approvals, trustedKeys);
    await holder.query(`INSERT INTO pulse_release_rehearsal.release_receipts
      (release_id,plan_sha256,migration_sha256,operator_subject,operator_key_id,reviewer_subject,reviewer_key_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [plan.releaseId, verified.digest, MIGRATION_SHA256,
        verified.operator.subject, verified.operator.keyId, verified.reviewer.subject, verified.reviewer.keyId]);
    killer = await connectVerified();
    const killed = await killer.query('SELECT pg_terminate_backend($1::integer, 5000::bigint) AS terminated', [pid]);
    insist(killed.rows[0]?.terminated === true, 'could not terminate only the synthetic migrator backend');
    let refused = false;
    try { await holder.query('SELECT 1'); } catch { refused = true; }
    insist(refused, 'terminated session unexpectedly accepted a query');
  } finally {
    if (killer) await killer.end().catch(() => {});
    await holder.end().catch(() => {});
  }
  const observer = await connectVerified();
  try {
    const state = await decideUnderLock(observer, plan);
    insist(state === RECOVERY.ABORTED, `unexpected interrupted-transaction recovery decision: ${state}`);
    console.log('PASS: backend terminated DURING transaction; canary, row and receipt rolled back');
    console.log('PASS: session lock released and post-crash evidence requires a NEW approved attempt');
  } finally { await observer.end().catch(() => {}); }
}
async function commitWithDiscardedAck({ plan, approvals, trustedKeys }) {
  const verified = verifyApprovals(plan, approvals, trustedKeys);
  const client = await connectVerified();
  try {
    await preflight(client);
    insist(await takeLock(client), 'could not hold lock for synthetic committed release');
    try {
      await preflight(client);
      const before = await readEvidence(client);
      insist(decideRecovery({ plan, lockHeld: true, baselineVerified: true, ...before }) === RECOVERY.ABORTED,
        'release not demonstrably absent before new approved transaction');
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1500ms'");
      await client.query("SET LOCAL statement_timeout = '4000ms'");
      await client.query(reviewedMigrationSql());
      await client.query(`INSERT INTO pulse_release_rehearsal.release_receipts
        (release_id,plan_sha256,migration_sha256,operator_subject,operator_key_id,reviewer_subject,reviewer_key_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [plan.releaseId, verified.digest, MIGRATION_SHA256,
          verified.operator.subject, verified.operator.keyId, verified.reviewer.subject, verified.reviewer.keyId]);
      await client.query('COMMIT');
      // Deterministic application-boundary simulation: the database returned
      // COMMIT OK, but the caller's success acknowledgment is deliberately
      // discarded. This does NOT claim to simulate a network fault mid-COMMIT.
      throw new Error('SIMULATED_COMMIT_ACK_DISCARDED');
    } catch (error) {
      insist(error?.message === 'SIMULATED_COMMIT_ACK_DISCARDED',
        `unexpected commit or SQL error: ${error?.message}`);
      console.log('PASS: caller discarded its COMMIT confirmation; release outcome treated as UNKNOWN');
    }
  } finally {
    // Simulate losing the original connection; its session-level lock is freed.
    await client.end().catch(() => {});
  }
  const reconciler = await connectVerified();
  try {
    // Never rerun a possibly committed migration merely because the client
    // lost its confirmation. Reconnect, reverify and acquire the SAME lock.
    const outcome = await decideUnderLock(reconciler, plan);
    insist(outcome === RECOVERY.APPLIED, `commit not verified by durable evidence: ${outcome}`);
    console.log('PASS: new session independently verified COMMITTED receipt and canary; replay FORBIDDEN');
    insist(decideRecovery({ plan, lockHeld: false, baselineVerified: true,
      ...(await readEvidence(reconciler)) }) === RECOVERY.QUARANTINE,
      'out-of-lock check cannot authorize recovery');
    console.log('PASS: reconciliation without the release lock quarantines the outcome');
  } finally { await reconciler.end().catch(() => {}); }
}

async function main() {
  guard();
  reviewedMigrationSql();
  const first = signedApprovals();
  const neverOpened = decideRecovery({ plan: first.plan, lockHeld: false,
    baselineVerified: false, receipt: undefined, canary: undefined });
  insist(neverOpened === RECOVERY.QUARANTINE, 'unknown evidence may not authorize retry');
  console.log('PASS: unknown/unavailable evidence fails closed before database connection');
  await runAbortedBackend(first);
  // Fresh *synthetic* independent signed authorization for a NEW attempt.
  const retry = signedApprovals();
  await commitWithDiscardedAck(retry);
  console.log('========== DISPOSABLE RELEASE FAILURE RECOVERY REHEARSAL COMPLETED ==========');
  console.log('NOTE: synthetic approvers; no external audit or production approval workflow');
}
main().catch(error => { console.error(error?.message ?? 'Unknown recovery test failure'); process.exitCode = 1; });
