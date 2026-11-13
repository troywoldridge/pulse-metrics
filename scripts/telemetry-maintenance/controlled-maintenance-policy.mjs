/**
 * Pulse Metrics D15C-5C — REVIEW-ONLY maintenance orchestration policy.
 * No imports of database drivers or process environment. No scheduler.
 * ALL callers must enforce their own independent, disposable-only guard.
 * The SQL maintenance function's own 48-hour cutoff / 250+250 batch ceiling
 * remain authoritative. Session advisory locks are COOPERATIVE, not ACLs.
 */
export const MAINTENANCE_POLICY = Object.freeze({
  lockKeyA: 1347771475, // stable, separate from release/adoption locks
  lockKeyB: 1296124238,
  maximumBatches: 3,
  maximumPerTablePerBatch: 250,
  database: 'pulse_metrics',
  role: 'pulse_metrics_test_maintainer',
  port: '55432',
});

function strictRow(result, fields) {
  if (!result || result.rowCount !== 1 ||
      !Array.isArray(result.rows) || result.rows.length !== 1 ||
      !result.rows[0] || typeof result.rows[0] !== 'object' ||
      Array.isArray(result.rows[0]) ||
      Object.keys(result.rows[0]).sort().join(',') !== [...fields].sort().join(',')) {
    throw Error('invalid_query_result');
  }
  return result.rows[0];
}

export function assertMaintenanceIdentity(result, expectedData) {
  // A restricted PostgreSQL role must NOT read `data_directory`: that
  // configuration setting is privileged. The disposable launcher has already
  // attested the exact physical cluster using a separate postgres session.
  const row = strictRow(result, [
    'db', 'role', 'session_role', 'local_only', 'port', 'tcp_disabled',
  ]);
  // Keep this controller test-only and reject malformed untrusted paths.
  // The database-to-directory binding is verified by the privileged launcher,
  // not by attempting to reveal a restricted PostgreSQL setting here.
  if (typeof expectedData !== 'string' ||
      !/^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/data$/.test(expectedData) ||
      row.db !== MAINTENANCE_POLICY.database ||
      row.role !== MAINTENANCE_POLICY.role ||
      row.session_role !== MAINTENANCE_POLICY.role ||
      row.local_only !== true || row.tcp_disabled !== true ||
      row.port !== MAINTENANCE_POLICY.port) {
    throw Error('identity_guard_rejected');
  }
}

// This restricted query must NOT resolve objects in protected schemas.
// Only session identity is checked here. The privileged disposable launcher
// independently audits object ACLs, while PostgreSQL enforces EXECUTE on the
// maintenance function when pruning is actually attempted. No grant changes.
const IDENTITY_SQL = `
  SELECT current_database() AS db, current_user AS role,
    session_user AS session_role, inet_server_addr() IS NULL AS local_only,
    current_setting('port') AS port,
    current_setting('listen_addresses') = '' AS tcp_disabled
`;

/**
 * db is a single dedicated, already connected PostgreSQL session; it must
 * NEVER be a shared pool because the advisory lock is SESSION-scoped.
 * report is an output callback for strictly sanitized, fixed-shape events.
 * Never pass SQL driver errors, host paths, secrets, SQL text or tenant IDs.
 */
export async function runControlledMaintenance(db, expectedData, report = () => {},
                                                reportDiagnostic = () => {}) {
  let acquired = false;
  // Labels are a fixed review-only vocabulary: never include SQL, driver errors,
  // network locations, tokens, object identifiers, or system paths.
  let phase = 'identity_query';
  let failure = false;
  let status = 'failed';
  let batches = 0;
  let networkRemoved = 0;
  let agentRemoved = 0;
  let possibleBacklog = false;
  try {
    const identity = await db.query(IDENTITY_SQL);
    phase = 'identity_assertion';
    assertMaintenanceIdentity(identity, expectedData);
    phase = 'lock_query';
    const lockResult = await db.query(
      'SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired',
      [MAINTENANCE_POLICY.lockKeyA, MAINTENANCE_POLICY.lockKeyB],
    );
    phase = 'lock_assertion';
    const lock = strictRow(lockResult, ['acquired']);
    if (typeof lock.acquired !== 'boolean') throw Error('invalid_lock_result');
    if (!lock.acquired) {
      status = 'overlap_skipped';
      report({ event: 'overlap_skipped', alert: false });
      return { status };
    }
    acquired = true;
    phase = 'prune_query';
    report({ event: 'maintenance_started', alert: false });
    for (let i = 0; i < MAINTENANCE_POLICY.maximumBatches; i += 1) {
      const pruneResult = await db.query(`
        SELECT network_removed, agent_removed
        FROM pulse_telemetry_maintenance.prune_expired_quota_buckets()
      `);
      phase = 'prune_assertion';
      const row = strictRow(pruneResult, ['network_removed', 'agent_removed']);
      const n = row.network_removed;
      const a = row.agent_removed;
      if (!Number.isSafeInteger(n) || n < 0 ||
          n > MAINTENANCE_POLICY.maximumPerTablePerBatch ||
          !Number.isSafeInteger(a) || a < 0 ||
          a > MAINTENANCE_POLICY.maximumPerTablePerBatch) {
        throw Error('invalid_prune_result');
      }
      batches += 1;
      networkRemoved += n;
      agentRemoved += a;
      report({ event: 'batch_completed', batch: batches,
        networkRemoved: n, agentRemoved: a, alert: false });
      if (n === 0 && a === 0) break;
      if (i === MAINTENANCE_POLICY.maximumBatches - 1) possibleBacklog = true;
      phase = 'prune_query';
    }
    status = 'completed';
  } catch {
    failure = true;
    try { reportDiagnostic(phase); } catch { /* never change security outcomes */ }
  } finally {
    if (acquired) {
      phase = 'unlock_query';
      try {
        const unlockResult = await db.query(
          'SELECT pg_advisory_unlock($1::integer,$2::integer) AS released',
          [MAINTENANCE_POLICY.lockKeyA, MAINTENANCE_POLICY.lockKeyB],
        );
        phase = 'unlock_assertion';
        const unlocked = strictRow(unlockResult, ['released']);
        if (unlocked.released !== true) throw Error('invalid_unlock_result');
      } catch {
        failure = true;
        try { reportDiagnostic(phase); } catch { /* never change security outcomes */ }
      }
    }
  }
  if (failure) {
    report({ event: 'maintenance_failed', reason: 'operation_unavailable',
      alert: true });
    return { status: 'failed' };
  }
  if (status === 'completed') {
    report({ event: 'maintenance_completed', batches, networkRemoved,
      agentRemoved, possibleBacklog, alert: possibleBacklog });
    return { status, batches, networkRemoved, agentRemoved, possibleBacklog };
  }
  report({ event: 'maintenance_failed', reason: 'operation_unavailable', alert: true });
  return { status: 'failed' };
}
