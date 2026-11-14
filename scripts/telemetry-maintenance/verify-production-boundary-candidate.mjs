#!/usr/bin/env node
/** D15C-5J: read-only, independent source fingerprint check. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'README-D15C-5J.md': '53d95a9eb7e58d50769c9d205cd8146bdd752cd1de2b0a405ba1c40ee1af2081',
  'docs/architecture/ADR-010-SECURE-MAINTENANCE-OPERATIONS.md': '5fab1ddbf0225574ced2248e73d1d4553d28ff25f80721517ccdeca1d19c04bb',
  'docs/security/D15C-5J-PRODUCTION-TRUST-BOUNDARIES.md': 'f7aed37f128f44c8289fe00c9d09f3cc755d878a05cddb172fbe0fb822047908',
  'docs/security/D15C-5J-RELEASE-GATE-REGISTER.json': '9697b5b5ecf5fbe600f50495bc72bee8db4ade5ee1a1b29b2c6690f56e012237',
  'scripts/telemetry-maintenance/production-security-boundary.mjs': '96334c978372dca910a1c4e1eb9b12d2fcbfeba316cbb87444b42e485d52ee77',
  'scripts/telemetry-maintenance/production-security-boundary.test.mjs': '8ef87998b1cb0cb00b92622b02050029dd72081ee7ce2d9b2c7d58923a6b12e5',
  'scripts/telemetry-maintenance/production-security-boundary-rehearsal.mjs': 'c1b58290be05ddcb9dee32f4da4f181fc0ff7f7bc9ffefe354d009884f14af01',
  'scripts/test-maintenance-production-boundaries.sh': 'aa32ed28316ca801b56a3aeb467759ed22b4d6beab9d551d3aeb012d7d742b2f',
});
try {
  if (process.argv.length !== 2) throw Error('unexpected arguments');
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const actual = createHash('sha256')
      .update(readFileSync(resolve(ROOT, name))).digest('hex');
    if (actual !== expected) throw Error('changed source');
  }
  console.log('PASS: D15C-5J source hashes and release register pinned SHA256');
  console.log('PUBLIC LAUNCH: NO_GO | architecture proposal only, no grants or providers');
} catch {
  console.error('REFUSE_D15C5J_SOURCE: review sources changed or missing');
  process.exitCode = 1;
}
