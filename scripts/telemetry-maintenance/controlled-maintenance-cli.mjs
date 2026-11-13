#!/usr/bin/env node
/**
 * D15C-5C DISPOSABLE TEST-ONLY operational entrypoint.
 * NOT a production daemon, live scheduler or database migration utility.
 * No DATABASE_URL, password, network, or arbitrary SQL parameters accepted.
 */
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { runControlledMaintenance } from './controlled-maintenance-policy.mjs';

const { Client } = pg;
const PATH = /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/;
function deny() {
  process.stdout.write('D15C5C_EVENT {"event":"configuration_denied","alert":true}\n');
  process.exitCode = 1;
}
// Never log a PG exception or variable text, even during a test.
// Diagnostic labels are emitted only inside the fully guarded disposable CLI.
const SAFE_STAGES = new Set([
  'connection', 'identity_query', 'identity_assertion',
  'lock_query', 'lock_assertion', 'prune_query', 'prune_assertion',
  'unlock_query', 'unlock_assertion',
]);
function testDiagnostic(stage) {
  if (process.env.PULSE_D15C5C_DIAGNOSTIC !== 'DISPOSABLE_ONLY') return;
  if (SAFE_STAGES.has(stage)) {
    process.stderr.write(`D15C5C_DIAGNOSTIC ${stage}\n`);
  }
}

function disposableGuard() {
  const env = process.env;
  const socket = env.PULSE_D15C5C_SOCKET;
  const data = env.PULSE_D15C5C_DATA;
  if (process.argv.length !== 2 || env.PULSE_D15C5C_DISPOSABLE_ONLY !== 'YES' ||
      env.NODE_ENV === 'production' || typeof socket !== 'string' ||
      !PATH.test(socket) || data !== `${dirname(socket)}/data` ||
      Object.keys(env).some(k => /^(?:PGPASSWORD|PGPASSFILE|PGHOST|PGHOSTADDR|PGPORT|PGUSER|PGDATABASE|PGSERVICE|PGSERVICEFILE|PGOPTIONS|PGCLUSTER|PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT)$/.test(k))) {
    return null;
  }
  for (const filename of ['.pulse-telemetry-quota-marker',
                          '.pulse-telemetry-agent-quota-marker']) {
    const marker = `${dirname(socket)}/${filename}`;
    try {
      if (!existsSync(marker) || !lstatSync(marker).isFile() ||
          lstatSync(marker).isSymbolicLink()) return null;
    } catch { return null; }
  }
  return { socket, data };
}

async function main() {
  const cfg = disposableGuard();
  if (!cfg) return deny();
  const db = new Client({
    host: cfg.socket, port: 55432, database: 'pulse_metrics',
    user: 'pulse_metrics_test_maintainer', ssl: false,
    connectionTimeoutMillis: 2500, statement_timeout: 1800,
    query_timeout: 2500, application_name: 'pulse-d15c5c-disposable-maintenance',
  });
  let result;
  try {
    await db.connect();
    result = await runControlledMaintenance(db, cfg.data, event => {
      process.stdout.write(`D15C5C_EVENT ${JSON.stringify(event)}\n`);
    }, testDiagnostic);
  } catch {
    testDiagnostic('connection');
    process.stdout.write('D15C5C_EVENT {"event":"maintenance_failed","reason":"operation_unavailable","alert":true}\n');
    process.exitCode = 1;
  } finally {
    try { await db.end(); } catch { process.exitCode = 1; }
  }
  if (result?.status === 'failed') process.exitCode = 1;
}
await main();
