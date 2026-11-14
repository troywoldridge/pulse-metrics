#!/usr/bin/env node
/** D15C-5N read-only source review. No database, HTTP or external tools. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = Object.freeze({
  'README-D15C-5N.md': '26bae9ab609179a4ce277593d90c0a26cdd4d373097041a6ae9779656373e1b3',
  'src/server/monitoring/history-preview-policy.ts': 'eeb81ea5632846cdebf70c9d972bb10bab0959fa3af2209d84a9665dbd41c4d6',
  'src/server/monitoring/history-preview-policy.test.ts': '74db8d2bfc20bf10df31228c55c6d5a41f12835a6cbf83b75fb57d0d10a75bb8',
  'src/server/monitoring/history-preview-app.ts': '1e73ea84706c12e9414caffbac016c05067e3d737d3a50663af81b65d6ef5572',
  'src/server/monitoring/history-preview-app.test.ts': '604c0a0995a8c1665f09330623772541a78eb0d3a5810c739a500e4733958b19',
  'scripts/monitoring-history/start-local-preview.ts': '9c3445b20ea9231314f0a3a62904cc2aebe738f206718c52b37ad1dffa03a434',
  'scripts/test-monitoring-history-preview.sh': '652857085983e57fb309cce379bcbffa1a7fb797249e307f3697c525d99b90b2',
});
try {
  if (process.argv.length !== 2 || process.env.NODE_ENV === 'production')
    throw new Error('invalid_environment_or_arguments');
  for (const [path, expected] of Object.entries(SOURCES)) {
    const actual = createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
    if (actual !== expected) throw new Error('source_modified');
  }
  const server = readFileSync(resolve(ROOT, 'server.ts'), 'utf8');
  if (!server.includes("app.use('/api', denyPendingMonitoringApi);") ||
      server.includes('createHistoryRoute') ||
      server.includes('history-preview-app') ||
      server.includes('start-local-preview') ||
      !server.includes("server.on('upgrade', rejectUnauthenticatedUpgrade);"))
    throw new Error('main_server_hold_modified');
  console.log('PASS: D15C-5N reviewed source hashes and unmounted main server hold');
  console.log('PUBLIC LAUNCH: NO_GO | localhost preview candidate only');
} catch {
  console.error('REFUSE_D15C5N_SOURCE: changed files, unauthorized mount or unsafe environment');
  process.exitCode = 1;
}
