#!/usr/bin/env node
/**
 * D15C-5A read-only source lock. NEVER connects to any database.
 * Both the expected fingerprint and the manifest must agree with SQL bytes.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_SHA256 =
  '5c8626cea57c4238698882b7260112cea1adfe017866af39ba14a2ffb39ddc5e';
export const CANDIDATE =
  'scripts/telemetry-maintenance/migrations/0001_telemetry_quota_retention.sql';
const MANIFEST = 'scripts/telemetry-maintenance/migrations/manifest.json';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function requireReview(condition, reason) {
  if (!condition) throw new Error(`REFUSE_D15C5A_SOURCE: ${reason}`);
}

export function verifyCandidate(base = root) {
  const manifest = JSON.parse(readFileSync(resolve(base, MANIFEST), 'utf8'));
  requireReview(
    manifest.formatVersion === 1 &&
      manifest.kind ===
        'review-only-privileged-telemetry-quota-maintenance-migration' &&
      manifest.phase === 'D15C-5A' &&
      manifest.database === 'pulse_metrics' &&
      Array.isArray(manifest.steps) && manifest.steps.length === 1,
    'unexpected manifest identity',
  );
  const step = manifest.steps[0];
  requireReview(
    step.version === '0001' && step.path === CANDIDATE &&
      step.sha256 === EXPECTED_SHA256 &&
      step.schema === 'pulse_telemetry_maintenance',
    'manifest differs from independent source lock',
  );
  const files = readdirSync(resolve(base, 'scripts/telemetry-maintenance/migrations'))
    .filter(name => /^\d{4}_.+\.sql$/.test(name));
  requireReview(files.length === 1 &&
    files[0] === '0001_telemetry_quota_retention.sql',
  'unexpected SQL migration versions');
  const bytes = readFileSync(resolve(base, CANDIDATE));
  const actual = createHash('sha256').update(bytes).digest('hex');
  requireReview(actual === EXPECTED_SHA256, 'SQL source fingerprint mismatch');
  const sql = bytes.toString('utf8');
  for (const marker of [
    'BEGIN;', 'COMMIT;',
    'pulse_telemetry_maintenance.schema_migrations',
    'pulse_telemetry_maintenance.prune_expired_quota_buckets()',
    'pulse_metrics_telemetry_maintenance_executor',
    'FOR UPDATE OF b SKIP LOCKED',
    'interval \'48 hours\'',
  ]) {
    requireReview(sql.includes(marker), `required marker missing: ${marker}`);
  }
  return { path: CANDIDATE, sha256: actual };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireReview(process.argv.length === 2, 'unexpected arguments');
    const verified = verifyCandidate();
    console.log(`PASS: D15C-5A SQL pinned SHA256 ${verified.sha256}`);
    console.log('PUBLIC LAUNCH: NO_GO | disposable review-only source');
  } catch (error) {
    console.error(error instanceof Error ? error.message :
      'REFUSE_D15C5A_SOURCE: verification failure');
    process.exitCode = 1;
  }
}
