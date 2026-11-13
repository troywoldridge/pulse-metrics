#!/usr/bin/env node
/** D15C-5E read-only independently pinned offline contract source verifier. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'README-D15C-5E.md':
    'e36b53c7e36bbfa2f88f90c2c2292a4b66d306ee6563a08efeaf34b6b998d6ac',
  'docs/security/D15C-5E-OPERATOR-ALERT-DESIGN.md':
    '959fd4e75b0f1ae5d4f41e680d1a35f9897e235f133eb384e404947fd34daa93',
  'scripts/telemetry-maintenance/operator-alert-contract.mjs':
    '7c8df5a01a9442bcc543c00b1e5b9c18f078c619364396d3b19d5001f7e5a6b4',
  'scripts/telemetry-maintenance/operator-alert-contract.test.mjs':
    '0331f6c2c1e49e4f43798fff24e0de0189e7177359441d5e1129958014f3fb0a',
  'scripts/telemetry-maintenance/operator-alert-dry-run.mjs':
    '5377ef524768b6847af8e2d947f48de6941733230ca2b424512e2f1ee5c8af3d',
  'scripts/test-maintenance-operator-alert-design.sh':
    'bfb7b8595b8a6e8d99243a1343f8957b6d7ffc73eacd66826b9ffa29685734ce'
});
try {
  if (process.argv.length !== 2) throw Error('unexpected arguments');
  for (const [file, expected] of Object.entries(EXPECTED)) {
    const actual = createHash('sha256')
      .update(readFileSync(resolve(ROOT, file))).digest('hex');
    if (actual !== expected) throw Error(`changed design candidate: ${file}`);
  }
  console.log('PASS: D15C-5E offline operator/alert design source pins verified');
  console.log('PUBLIC LAUNCH: NO_GO | design-only, no operator or alert transport');
} catch {
  console.error('REFUSE_D15C5E_SOURCE: design candidate changed or unavailable');
  process.exitCode = 1;
}
