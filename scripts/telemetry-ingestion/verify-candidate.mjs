#!/usr/bin/env node

/**
 * Pulse Metrics D15B — read-only migration source verifier.
 *
 * No database access, environment-file loading, network access,
 * or migration execution.
 *
 * This verifies the reviewed candidate, not production approval.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_SHA256 =
  '3a49fc829b985fefe68616dcc525da83138b18e3d199d18d02817d5751f6b513';

export const CANDIDATE =
  'scripts/telemetry-ingestion/migrations/0001_telemetry_ingestion.sql';

const MANIFEST =
  'scripts/telemetry-ingestion/migrations/manifest.json';

function insist(condition, reason) {
  if (!condition) {
    throw new Error(`REFUSE_D15B_CANDIDATE: ${reason}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyCandidate(root) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, MANIFEST), 'utf8')
  );

  insist(
    manifest.formatVersion === 1 &&
    manifest.kind ===
      'review-only-privileged-telemetry-ingestion-migration' &&
    manifest.phase === 'D15B' &&
    manifest.database === 'pulse_metrics' &&
    Array.isArray(manifest.steps) &&
    manifest.steps.length === 1,
    'unexpected migration manifest'
  );

  const step = manifest.steps[0];

  insist(
    step.version === '0001' &&
    step.path === CANDIDATE &&
    step.sha256 === EXPECTED_SHA256 &&
    step.schema === 'pulse_telemetry_ingestion',
    'migration manifest differs from independent source lock'
  );

  const directory = resolve(
    root,
    'scripts/telemetry-ingestion/migrations'
  );

  const migrationFiles = readdirSync(directory)
    .filter(name => /^\d{4}_.+\.sql$/.test(name));

  insist(
    migrationFiles.length === 1 &&
    migrationFiles[0] === '0001_telemetry_ingestion.sql',
    'unexpected migration versions'
  );

  const bytes = readFileSync(resolve(root, CANDIDATE));

  insist(
    sha256(bytes) === EXPECTED_SHA256,
    'migration SQL fingerprint mismatch'
  );

  const sql = bytes.toString('utf8');

  insist(
    sql.includes('BEGIN;') &&
    sql.includes('COMMIT;') &&
    sql.includes(
      'pulse_telemetry_ingestion.schema_migrations'
    ) &&
    sql.includes(
      'pulse_telemetry_ingestion.ingest_submission'
    ) &&
    sql.includes(
      'pulse_metrics_telemetry_executor'
    ),
    'required migration identity markers missing'
  );

  return {
    version: '0001',
    sha256: EXPECTED_SHA256,
    path: CANDIDATE,
  };
}

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
);

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    insist(
      process.argv.length === 2,
      'unexpected command arguments'
    );

    const verified = verifyCandidate(root);

    console.log(
      `PASS: D15B migration ${verified.version} ` +
      `pinned SHA256 ${verified.sha256}`
    );
    console.log(
      'PASS: manifest and migration SQL match independent source lock'
    );
    console.log(
      'PUBLIC LAUNCH: NO_GO | source verification only'
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'REFUSE_D15B_CANDIDATE: verification failed'
    );
    process.exitCode = 1;
  }
}
