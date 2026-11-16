/**
 * Pulse Metrics — D15C-5U-2F2E. Disposable restart audit validation.
 * NO database connections or side effects. No production or persistent pilot admission.
 */
import assert from 'node:assert/strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOCKET = /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/;
const COLUMNS = Object.freeze([
  'recorded_at', 'received_at', 'cpu_usage_percent',
  'memory_usage_percent', 'disk_usage_percent',
  'network_receive_bytes_per_second',
  'network_transmit_bytes_per_second',
].sort());

export function validateRestartEnvironment(env) {
  assert.equal(process.platform, 'linux');
  assert.equal(env.PULSE_D15C5T_ONLY, 'YES');
  assert.equal(env.PULSE_D15C4_DISPOSABLE_ONLY, 'YES');
  assert.equal(env.PULSE_D15C5T_RESTART_VERIFIED, 'YES');
  assert.equal(env.NODE_ENV ?? 'development', 'development');
  assert.notEqual(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  for (const key of [
    'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'DATABASE_URL',
    'MIGRATION_DATABASE_URL', 'PGHOST', 'PGHOSTADDR', 'PGPORT',
    'PGSERVICE', 'PGPASSWORD', 'PGPASSFILE',
  ]) assert.equal(env[key], undefined, `${key} must not be inherited`);
  assert.match(env.PULSE_D15C4_SOCKET ?? '', SOCKET);
  assert.equal(env.PULSE_D15C4_DATA, `${env.PULSE_D15C4_SOCKET.slice(0, -7)}/data`);
  assert.match(env.PULSE_D15C4_ORG_A ?? '', UUID);
  assert.match(env.PULSE_D15C4_ORG_B ?? '', UUID);
  assert.notEqual(env.PULSE_D15C4_ORG_A, env.PULSE_D15C4_ORG_B);
  assert.match(env.PULSE_D15C5T_OWNER_A ?? '', UUID);
  assert.match(env.PULSE_D15C5T_OWNER_B ?? '', UUID);
  assert.notEqual(env.PULSE_D15C5T_OWNER_A, env.PULSE_D15C5T_OWNER_B);
  return Object.freeze({
    socket: env.PULSE_D15C4_SOCKET,
    data: env.PULSE_D15C4_DATA,
    orgA: env.PULSE_D15C4_ORG_A,
    orgB: env.PULSE_D15C4_ORG_B,
    ownerA: env.PULSE_D15C5T_OWNER_A,
    ownerB: env.PULSE_D15C5T_OWNER_B,
  });
}

export function validateDatabaseIdentity(row, context) {
  assert.deepEqual(row, {
    db: 'pulse_metrics', role: 'pulse_metrics_app',
    port: '55432', unix_only: true,
  });
}

export function validateAgentRow(rows, expectedStatus) {
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 1, 'Expected exactly one own-agent row');
  const row = rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['id', 'status'].sort());
  assert.match(row.id ?? '', UUID);
  assert.equal(row.status, expectedStatus);
  return row.id;
}

function validPercent(value) {
  return value === null || (typeof value === 'number' &&
    Number.isFinite(value) && value >= 0 && value <= 100);
}
function validCounter(value) {
  return value === null || (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value));
}

export function validateReadback(actual) {
  assert.deepEqual(Object.keys(actual).sort(), ['authorized','agentFound','samples'].sort());
  assert.equal(actual.authorized, true);
  assert.equal(actual.agentFound, true);
  assert.equal(actual.samples.length, 1, 'Unexpected number of retained pilot samples');
  const row = actual.samples[0];
  assert.deepEqual(Object.keys(row).sort(), COLUMNS, 'Raw JSON or private fields exposed');
  for (const field of ['recorded_at','received_at']) {
    assert.ok(row[field] instanceof Date && Number.isFinite(row[field].getTime()));
  }
  for (const field of ['cpu_usage_percent','memory_usage_percent','disk_usage_percent']) {
    assert.ok(validPercent(row[field]), `${field} is not an honest nullable percent`);
  }
  for (const field of ['network_receive_bytes_per_second','network_transmit_bytes_per_second']) {
    assert.ok(validCounter(row[field]), `${field} is not an honest nullable counter`);
  }
  return true;
}

export function validateDeniedReadback(actual, missingAgent = false) {
  assert.deepEqual(actual, missingAgent
    ? { authorized: true, agentFound: false, samples: [] }
    : { authorized: false, agentFound: false, samples: [] });
}
