#!/usr/bin/env node
/**
 * D15C-5D read-only source lock, updated for reviewed two-pass journal guard.
 * No DB access, network or file writes. Original 5D policy, CLI and policy
 * test files remain pinned to their independent initial review fingerprints.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expected = Object.freeze({
  'scripts/telemetry-maintenance/maintenance-audit-policy.mjs':
    'c389ba785dbecb9e5ba1b3a26c008cd3225f3607019958db16ce40d2297c5904',
  'scripts/telemetry-maintenance/maintenance-audit-cli.mjs':
    '1285228e1286d9d987a878af40e5cc1823dac515abf597d03d741360d5a4ebb8',
  'scripts/telemetry-maintenance/maintenance-audit.test.mjs':
    'c10842c67f069f3f2269e73cad283b205babfe41431de662a5ce9cb21726a0b8',
  'scripts/telemetry-maintenance/maintenance-audit-rehearsal-phase.mjs':
    '06710c28b8211f2bbd713057ebe7d294acd914898a91fdb864427544f8584fa0',
  'scripts/telemetry-maintenance/maintenance-audit-rehearsal-phase.test.mjs':
    'fe59db85f67bdc28e46538ecf46cbbfdd2f6e45fd61e2923159df43ec071d5e2',
  'scripts/telemetry-maintenance/maintenance-audit.integration.mjs':
    '8708c4f4473f46df3441ebafbbbea5ce2bc1bac7fd6ccfd57e2d462d6caa92a5',
  'scripts/test-telemetry-audit-alert-rehearsal.sh':
    'fb19b7e083aba1b91df5fd291d7e48005300234556eee681b86964187504a65a',
});
try {
  if (process.argv.length !== 2) throw Error('unexpected arguments');
  for (const [file,hash] of Object.entries(expected)) {
    const actual = createHash('sha256').update(readFileSync(resolve(root,file)))
      .digest('hex');
    if (actual !== hash) throw Error(`source changed: ${file}`);
  }
  // Pin the committed D15C-5C controller even after the 5D integration fix.
  const parent = createHash('sha256').update(readFileSync(resolve(root,
    'scripts/telemetry-maintenance/controlled-maintenance-cli.mjs'))).digest('hex');
  if (parent !== '4a7dbafe516f5113bfb25df2ea5d52e84bf8e171ef0834e31c6b397ff20b0320') {
    throw Error('previously approved D15C-5C controller changed');
  }
  console.log('PASS: D15C-5D reviewed sources and two-pass journal guard pinned SHA256');
  console.log('PUBLIC LAUNCH: NO_GO | disposable journal and alert candidates only');
} catch (error) {
  console.error('REFUSE_D15C5D_SOURCE:',error instanceof Error ? error.message : 'invalid');
  process.exitCode = 1;
}
