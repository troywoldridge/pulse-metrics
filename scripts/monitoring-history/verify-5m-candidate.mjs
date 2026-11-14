#!/usr/bin/env node
/** D15C-5M read-only source review; never connects to a database or host. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'README-D15C-5M.md': 'c4229ceed0ed149ccc18eeb2b4215ac92dd773fd548b4437bcab09a00b2efbd2',
  'scripts/monitoring-history/fixtures-5m.sql': 'aae13e45afb616386c4bd534dfd9cea7627743c57e43df9a72b39d4dcbda2695',
  'scripts/test-monitoring-history-postgres.sh': '88f7eff3fa3b1be6b3a851c01f6fbc043bb15b3b07fc2245390425103a5126b6',
  'tests/integration/monitoring-history-postgres.integration.test.ts': '6ce39043b33c456e6dcaf3df7cdb551c0b4592a1ac4f9dd3cc43bf65e99979df',
});

try {
  if (process.argv.length !== 2 || process.env.NODE_ENV === 'production') {
    throw new Error('disallowed_arguments_or_environment');
  }
  for (const [path, expected] of Object.entries(EXPECTED)) {
    const digest = createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
    if (digest !== expected) throw new Error('source_mismatch');
  }
  const server = readFileSync(resolve(ROOT, 'server.ts'), 'utf8');
  const history = readFileSync(resolve(ROOT, 'src/server/monitoring/history-service.ts'), 'utf8');
  if (!server.includes("app.use('/api', denyPendingMonitoringApi);") ||
      server.includes('createHistoryRoute(') ||
      server.includes('readHistoryForIdentity(') ||
      !history.includes('withOrganizationContext(') ||
      !history.includes('resolveAuthenticatedUserId(')) {
    throw new Error('server_hold_or_history_boundary_modified');
  }
  console.log('PASS: D15C-5M sources verified and server monitoring hold remains intact');
  console.log('PUBLIC LAUNCH: NO_GO | disposable test only; no live route enabled');
} catch {
  console.error('REFUSE_D15C5M_SOURCE: unreviewed files, modified boundary or production context');
  process.exitCode = 1;
}
