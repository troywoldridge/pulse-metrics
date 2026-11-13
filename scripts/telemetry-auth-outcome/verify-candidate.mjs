#!/usr/bin/env node
/** D15C-4E strict source lock. Read-only: no DB, network, env, or migrations. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const path = 'scripts/telemetry-auth-outcome/migrations/0002_machine_credential_rejection.sql';
const expected = '3061f797a7d1fa0dfb335130252c4d89a3d1ee50d263854a22caa2a6c4d8c771';
function refuse(reason) { throw new Error(`REFUSE_D15C4E_SOURCE: ${reason}`); }
export function verifyCandidate() {
  const manifest = JSON.parse(readFileSync(resolve(root,
    'scripts/telemetry-auth-outcome/migrations/manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 ||
      manifest.kind !== 'review-only-credential-rejection-outcome-migration' ||
      manifest.phase !== 'D15C-4E' || manifest.database !== 'pulse_metrics' ||
      !Array.isArray(manifest.steps) || manifest.steps.length !== 1) {
    refuse('unexpected manifest');
  }
  const step = manifest.steps[0];
  if (step.version !== '0002' || step.path !== path ||
      step.schema !== 'pulse_telemetry_agent_quota' || step.sha256 !== expected) {
    refuse('manifest differs from independent source lock');
  }
  const files = readdirSync(resolve(root, 'scripts/telemetry-auth-outcome/migrations'))
    .filter(name => /^\d{4}_.+\.sql$/.test(name));
  if (files.length !== 1 || files[0] !== '0002_machine_credential_rejection.sql') {
    refuse('unexpected migration files');
  }
  const data = readFileSync(resolve(root, path));
  if (createHash('sha256').update(data).digest('hex') !== expected) {
    refuse('SQL SHA-256 mismatch');
  }
  const sql = data.toString('utf8');
  if (!sql.endsWith('\nCOMMIT;\n') || sql.match(/\nCOMMIT;/g)?.length !== 1 ||
      (sql.match(/RETURN 'credential_unavailable';/g) ?? []).length !== 3 ||
      sql.includes("RAISE EXCEPTION 'Machine credential unavailable'") ||
      !sql.includes("RETURN 'rate_limited:'") ||
      !sql.includes('REFUSE_D15C4E')) {
    refuse('expected security or outcome markers absent');
  }
  return { sha256: expected };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) refuse('unexpected CLI arguments');
    const info = verifyCandidate();
    console.log(`PASS: D15C-4E pinned SQL SHA256 ${info.sha256}`);
    console.log('PUBLIC LAUNCH: NO_GO | isolated review-only candidate');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'REFUSE_D15C4E_SOURCE');
    process.exitCode = 1;
  }
}
