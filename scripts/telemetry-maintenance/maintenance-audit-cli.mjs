#!/usr/bin/env node
/**
 * D15C-5D DISPOSABLE-ONLY audit wrapper for pinned D15C-5C CLI.
 * NO production identity, notifications, cron, database migrations or endpoints.
 * No arguments, DATABASE_URL or PostgreSQL libpq overrides accepted.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireAuditJournalLock, appendAuditRecord, assertPrivateAuditDirectory,
         classifyController, verifyAuditJournal } from './maintenance-audit-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTROLLER = resolve(ROOT, 'scripts/telemetry-maintenance/controlled-maintenance-cli.mjs');
const SOCKET_PATTERN = /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/;
const PG_OVERRIDE = /^(?:PGPASSWORD|PGPASSFILE|PGHOST|PGHOSTADDR|PGPORT|PGUSER|PGDATABASE|PGSERVICE|PGSERVICEFILE|PGOPTIONS|PGCLUSTER|PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT)$/;

function guardedConfig() {
  const env = process.env;
  const socket = env.PULSE_D15C5D_SOCKET;
  const data = env.PULSE_D15C5D_DATA;
  const output = env.PULSE_D15C5D_AUDIT_DIR;
  if (process.argv.length !== 2 || env.PULSE_D15C5D_DISPOSABLE_ONLY !== 'YES' ||
      env.NODE_ENV === 'production' || env.DATABASE_URL ||
      Object.keys(env).some(name => PG_OVERRIDE.test(name)) ||
      typeof socket !== 'string' || !SOCKET_PATTERN.test(socket) ||
      data !== `${dirname(socket)}/data`) return null;
  try {
    for (const file of ['.pulse-telemetry-quota-marker',
                        '.pulse-telemetry-agent-quota-marker']) {
      const marker = `${dirname(socket)}/${file}`;
      if (!existsSync(marker) || !lstatSync(marker).isFile() ||
          lstatSync(marker).isSymbolicLink()) return null;
    }
    assertPrivateAuditDirectory(output);
    verifyAuditJournal(output);
  } catch { return null; }
  return { socket, data, output };
}

function emit(type, obj) {
  process.stdout.write(`D15C5D_${type} ${JSON.stringify(obj)}\n`);
}
function main() {
  const cfg = guardedConfig();
  if (!cfg) {
    emit('EVENT', {event:'audit_configuration_denied', alert:true});
    process.exitCode = 1;
    return;
  }
  let row;
  try {
    // Separate local lock serializes journal writers, including the child run.
    // An existing/stale lock fails closed; do not silently steal it.
    const release = acquireAuditJournalLock(cfg.output);
    try {
      // The nested 5C controller retains its own independent SQL/role guard.
      // Never pass through raw SQL errors, stdout or stderr.
      const child = spawnSync(process.execPath, [CONTROLLER], {
        cwd: ROOT, encoding: 'utf8', timeout: 12000, maxBuffer: 16384,
        env: { ...process.env,
          PULSE_D15C5C_DISPOSABLE_ONLY: 'YES',
          PULSE_D15C5C_SOCKET: cfg.socket,
          PULSE_D15C5C_DATA: cfg.data,
          PULSE_D15C5C_DIAGNOSTIC: '',
        },
      });
      const classified = classifyController({
        exitCode: child.status,
        signal: child.signal,
        stdout: child.stdout,
        stderr: child.stderr,
      });
      row = appendAuditRecord(cfg.output, classified);
    } finally {
      release();
    }
  } catch {
    // Never report success after a journal, lock or storage failure.
    emit('EVENT', {event:'audit_storage_failed', alert:true});
    process.exitCode = 1;
    return;
  }
  emit('EVENT', { event: 'audit_recorded', sequence: row.sequence,
    status: row.status, batches: row.batches,
    networkRemoved: row.networkRemoved, agentRemoved: row.agentRemoved,
    alert: row.alertCode !== null });
  if (row.alertCode !== null) {
    // Local signal only. No outbound delivery or active scheduler.
    emit('ALERT', { event: 'alert_candidate', sequence: row.sequence,
      code: row.alertCode, severity: row.severity });
  }
  if (row.status === 'failed' || row.status === 'invalid_output') process.exitCode = 1;
}
main();
