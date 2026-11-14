#!/usr/bin/env node
/** D15C-5O: source SHA-256 and disabled-monitoring guard. Offline only. */
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'README-D15C-5O.md': '28abe2fc6ea82015b7492f63d9842e6eea2f5ee19bc77b3cef876a4631849b7d',
  'src/monitoring/history-client.ts': 'a89fa7724bc9e4a9f0b88d50c2c536ead78acaddd90c42b89d91d9c5e8dc69c8',
  'src/monitoring/history-client.test.ts': '964cb69b7c80e3d3c148b01a9a2351719a1a11f3984f46f36b1195c4cb43f765',
  'src/monitoring/history-state.ts': '5cbb8ef054e54cbbb0bd2d734e3364498cab06ce1724be086cd7c3d60f4f7e77',
  'src/monitoring/history-state.test.ts': '5806075e3aed5012b08d7ac3e9f1916a0fb4373a46ca116bc0abe541e25c87ec',
  'src/components/RealHistoryPanel.tsx': 'c13b74c0c3bb0237ee4ba41e4fab48a543af6597fddaed051e8c837f7cffc137',
  'src/components/RealHistoryPanel.test.tsx': '7155227f784d922bf6e2aa18470914ad7553065a16f1ac6bf1f0aa9c98698637',
  'src/components/AuthenticatedHistoryDashboard.tsx': 'c738c32297bffe9d7c5aff053da5b941b72e66debad75766dc322b0be9dc07d3',
  'scripts/test-monitoring-dashboard-foundation.sh': '14d85d2f7ecf08980d283f1bdbdb65ced23fd3a6fbc2f4fadce69502922c4ded',
});

function readSource(relative) {
  const absolute = resolve(ROOT, relative);
  if (!lstatSync(absolute).isFile()) throw new Error('unrecognized_source_type');
  const bytes = readFileSync(absolute);
  if (bytes.includes(13) || bytes.toString('utf8').split('\n').some(line => /[ \t]+$/.test(line))) {
    throw new Error('whitespace_or_crlf');
  }
  return bytes;
}

try {
  if (process.argv.length !== 2 || process.env.NODE_ENV === 'production') {
    throw new Error('invalid_environment');
  }
  for (const [path, digest] of Object.entries(EXPECTED)) {
    const actual = createHash('sha256').update(readSource(path)).digest('hex');
    if (actual !== digest) throw new Error('unreviewed_source');
  }
  const server = readFileSync(resolve(ROOT, 'server.ts'), 'utf8');
  const main = readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8');
  const boundary = readFileSync(resolve(ROOT, 'src/components/AuthenticatedBoundary.tsx'), 'utf8');
  const history = readFileSync(resolve(ROOT, 'src/server/monitoring/history-service.ts'), 'utf8');
  const client = readFileSync(resolve(ROOT, 'src/monitoring/history-client.ts'), 'utf8');
  if (!server.includes("app.use('/api', denyPendingMonitoringApi);") ||
      server.includes('createHistoryRoute(') ||
      server.includes('AuthenticatedHistoryDashboard') ||
      main.includes('AuthenticatedHistoryDashboard') ||
      boundary.includes('AuthenticatedHistoryDashboard') ||
      !history.includes('withOrganizationContext(') ||
      !history.includes('resolveAuthenticatedUserId(') ||
      /https?:\/\//.test(client) ||
      /localStorage|sessionStorage|Math\.random|WebSocket/.test(client)) {
    throw new Error('legacy_hold_or_tenant_safety_modified');
  }
  console.log('PASS: D15C-5O reviewed source hashes and unmounted production hold');
  console.log('PUBLIC LAUNCH: NO_GO | honest read-only UI candidate only');
} catch {
  console.error('REFUSE_D15C5O_SOURCE: unreviewed source, unsafe mount or environment');
  process.exitCode = 1;
}
