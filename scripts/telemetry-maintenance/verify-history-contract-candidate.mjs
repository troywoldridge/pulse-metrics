/** D15C-5L reviewed source hash gate; offline and non-deploying. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expected = Object.freeze({
  'README-D15C-5L.md': 'b8e354a001e7f5b47b223aec9adaffef2434918f2e17fe213cdac2b1f105f2f4',
  'src/server/monitoring/history-contract.ts': '66a4e0da190c2cf99a4258a70cfc00c3bae331da95f2e77a25211c421e4dedaf',
  'src/server/monitoring/history-service.ts': 'e4936198d88c82e6d1ec9e4871818f341cdb5d7859d0df5d00a42d32736cee0c',
  'src/server/monitoring/history-route.ts': '2e626a86b66f434a43a40e79fd3ead971392afc07f11e22fc66111ba1817c0fc',
  'src/server/monitoring/history-contract.test.ts': '42c3c0dd8a1e5d8acc34eb89d3877979cc6d8e2bcf73e2afc351e41bc5179a0e',
  'src/server/monitoring/history-route.test.ts': '36327bcf5d0cf80735fcbf050bd39f82129f8c16d6ede4d19da0ffe1f53a1651',
  'scripts/test-monitoring-history-contract.sh': '4a95b6e5e1a6f61aee8a8b0eb554cff973deef215c70946d8f104ccebf2a0699',
});

for (const [path, sha] of Object.entries(expected)) {
  const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  assert.equal(actual, sha, `D15C-5L review changed: ${path}`);
}
// A separate review must authorize ANY monitoring mount. This milestone cannot.
const server = readFileSync(resolve(root, 'server.ts'), 'utf8');
assert.ok(server.includes("app.use('/api', denyPendingMonitoringApi);"), 'Monitoring hold must remain');
assert.ok(!server.includes('createHistoryRoute'), 'Historical route must remain unmounted');
assert.ok(!server.includes("from './src/server/monitoring/"), 'Monitoring candidate must remain unmounted');
console.log('PASS: D15C-5L source hashes reviewed; legacy monitoring hold intact');
console.log('PUBLIC LAUNCH: NO_GO | candidate only');
