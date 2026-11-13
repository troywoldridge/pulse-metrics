#!/usr/bin/env node
/** D15C-4B: read-only, independent reviewed SQL source verification. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const path = 'scripts/telemetry-agent-quota/migrations/0001_telemetry_agent_quota.sql';
const expected = 'a90ec4b3c0b83c53b147d0160ab589cf673bfb032898b46075ce9c0b28f5f012';
const fail = reason => { throw new Error(`REFUSE_D15C4_SOURCE: ${reason}`); };

export function verifyCandidate() {
  const manifest = JSON.parse(readFileSync(resolve(root,
    'scripts/telemetry-agent-quota/migrations/manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 ||
      manifest.kind !== 'review-only-privileged-authenticated-agent-quota-migration' ||
      manifest.phase !== 'D15C-4B' ||
      manifest.database !== 'pulse_metrics' ||
      !Array.isArray(manifest.steps) || manifest.steps.length !== 1) {
    fail('invalid independent migration manifest');
  }
  const step = manifest.steps[0];
  if (step.version !== '0001' || step.path !== path ||
      step.schema !== 'pulse_telemetry_agent_quota' || step.sha256 !== expected) {
    fail('manifest mismatch with independent source lock');
  }
  const files = readdirSync(resolve(root, 'scripts/telemetry-agent-quota/migrations'))
    .filter(name => /^\d{4}_.+\.sql$/.test(name));
  if (files.length !== 1 || files[0] !== '0001_telemetry_agent_quota.sql') {
    fail('unexpected migration version/file');
  }
  const sql = readFileSync(resolve(root, path));
  if (createHash('sha256').update(sql).digest('hex') !== expected) {
    fail('pinned SQL SHA-256 differs from reviewed source');
  }
  const text = sql.toString('utf8');
  for (const marker of [
    'pulse_telemetry_agent_quota.consume_new_submission',
    'CREATE OR REPLACE FUNCTION pulse_telemetry_ingestion.ingest_submission',
    "RETURN 'duplicate'", "RETURN 'conflict'", "RETURN 'rate_limited:'",
    'pulse_metrics_telemetry_agent_quota_executor',
    'REFUSE_D15C4',
  ]) {
    if (!text.includes(marker)) fail(`expected SQL marker missing: ${marker}`);
  }
  if (!text.endsWith('\nCOMMIT;\n') || text.match(/\nCOMMIT;/g)?.length !== 1) {
    fail('unexpected SQL transaction boundary');
  }
  return { path, hash: expected };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('unexpected CLI arguments');
    const result = verifyCandidate();
    console.log(`PASS: D15C-4B SQL pinned SHA256 ${result.hash}`);
    console.log('PUBLIC LAUNCH: NO_GO | review-only candidate');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'REFUSE_D15C4_SOURCE');
    process.exitCode = 1;
  }
}
