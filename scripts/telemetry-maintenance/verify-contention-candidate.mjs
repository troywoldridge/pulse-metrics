#!/usr/bin/env node
/**
 * D15C-5B independently pinned rehearsal source check (NO DATABASE ACCESS).
 * Source hashes are fixed review identities, not runtime-generated trust.
 * Historical/pinned SQL remains managed by its own source verifiers.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'scripts/test-telemetry-quota-contention-rehearsal.sh':
    '0293e924b12b85b0827250241c507b490cc0eaa1ead6f06dd45052cd957416c5',
  'scripts/telemetry-maintenance/retention-contention-integration.mjs':
    'ef58980ba23b336bd88c2a243ed05fd536d74df091326e7af71b1363fa85f1a3',
});

function verify() {
  if (process.argv.length !== 2) throw Error('Unexpected verifier arguments');
  for (const [path, expected] of Object.entries(EXPECTED)) {
    const bytes = readFileSync(resolve(ROOT, path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw Error(`Review-required source mismatch: ${path}`);
  }
  console.log('PASS: D15C-5B full rehearsal script and integration test pinned SHA256');
  console.log('PUBLIC LAUNCH: NO_GO | disposable rehearsal only');
}

try { verify(); } catch (error) {
  console.error('REFUSE_D15C5B_SOURCE:',
    error instanceof Error ? error.message : 'unknown verification error');
  process.exitCode = 1;
}
