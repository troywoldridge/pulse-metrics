#!/usr/bin/env node
/**
 * D15C-3B — read-only source verification. No database connection.
 * This verifies file integrity, not SQL correctness or release approval.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const path = 'scripts/telemetry-quota/migrations/0001_telemetry_network_quota.sql';
const manifestPath = 'scripts/telemetry-quota/migrations/manifest.json';
const expectedHash = '4cce6ab1a31d4f0f323e6c5ad380b46fc21f1611198b44cf914b74118e29afe8';

function refuse(reason) {
  throw new Error(`REFUSE_D15C_QUOTA_SOURCE: ${reason}`);
}

function verify() {
  const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'));
  if (manifest.formatVersion !== 1 ||
      manifest.kind !== 'review-only-privileged-telemetry-network-quota-migration' ||
      manifest.phase !== 'D15C-3B' ||
      manifest.database !== 'pulse_metrics' ||
      !Array.isArray(manifest.steps) || manifest.steps.length !== 1) {
    refuse('unexpected migration manifest');
  }
  const [step] = manifest.steps;
  if (step.version !== '0001' || step.path !== path ||
      step.schema !== 'pulse_telemetry_quota' ||
      step.sha256 !== expectedHash) {
    refuse('manifest differs from independent source lock');
  }
  const directory = resolve(root, 'scripts/telemetry-quota/migrations');
  const versions = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name));
  if (versions.length !== 1 || versions[0] !== '0001_telemetry_network_quota.sql') {
    refuse('unexpected migration SQL files');
  }
  const bytes = readFileSync(resolve(root, path));
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) refuse('SQL fingerprint mismatch');
  const source = bytes.toString('utf8');
  for (const marker of [
    'BEGIN;', 'COMMIT;',
    'CREATE SCHEMA pulse_telemetry_quota;',
    'CREATE TABLE pulse_telemetry_quota.network_buckets',
    'CREATE FUNCTION pulse_telemetry_quota.consume_network_quota',
    'SECURITY DEFINER',
    'ALTER TABLE pulse_telemetry_quota.network_buckets FORCE ROW LEVEL SECURITY;',
    'pulse_metrics_telemetry_quota_executor',
  ]) {
    if (!source.includes(marker)) refuse('required SQL identity marker missing');
  }
}

try {
  if (process.argv.length !== 2) refuse('unexpected arguments');
  verify();
  console.log('PASS: D15C-3B telemetry network quota source hash and manifest match');
  console.log('PUBLIC LAUNCH: NO_GO | source verification only');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'REFUSE_D15C_QUOTA_SOURCE');
  process.exitCode = 1;
}
