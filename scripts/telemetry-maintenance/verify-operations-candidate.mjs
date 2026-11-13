#!/usr/bin/env node
/**
 * Pulse Metrics D15C-5C read-only review fingerprint verifier.
 * Checks complete code bytes against independently recorded SHA256 values.
 * NEVER opens a database, runs maintenance, creates roles or enables cron.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'scripts/telemetry-maintenance/controlled-maintenance-policy.mjs':
    '3996404a8d8a197f5c1b4924c0cf7f479f2272dd17a78b972ac838aeb32556ab',
  'scripts/telemetry-maintenance/controlled-maintenance-cli.mjs':
    '4a7dbafe516f5113bfb25df2ea5d52e84bf8e171ef0834e31c6b397ff20b0320',
  'scripts/telemetry-maintenance/controlled-maintenance.test.mjs':
    '71fa93fb418609eb6ba5eeaf9a433aaf7ed7e793efe17b02c3d063396b9f7c18',
  'scripts/telemetry-maintenance/controlled-maintenance.integration.mjs':
    '389580c4234610378143d1d6b31ab870e9919579ccf93c7fa4e732a648e3807b',
  'scripts/test-telemetry-controlled-maintenance-rehearsal.sh':
    'bc0f7ca1ee8f36706afd5ce4f00a610b841fd9515c74a69b9bb3cb011f275a23'
});

try {
  if (process.argv.length !== 2) throw Error('unexpected verifier arguments');
  for (const [path, expected] of Object.entries(EXPECTED)) {
    const actual = createHash('sha256')
      .update(readFileSync(resolve(ROOT, path))).digest('hex');
    if (actual !== expected) throw Error(`review-required changed source: ${path}`);
  }
  console.log('PASS: D15C-5C full operational policy, CLI, tests and rehearsal source pins verified');
  console.log('PUBLIC LAUNCH: NO_GO | review-only disposable operational rehearsal');
} catch (error) {
  console.error('REFUSE_D15C5C_SOURCE:', error instanceof Error ? error.message :
    'unknown source verification failure');
  process.exitCode = 1;
}
