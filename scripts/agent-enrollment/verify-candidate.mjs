#!/usr/bin/env node
/** Phase 2E3C5D9: immutable enrollment migration candidate source verification.
 * READ-ONLY; no environment-file reading, network, database or migration apply.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const EXPECTED_BASELINE = '2afc6d35019aef5288d19a184ff16144e5b05b31';
export const EXPECTED_SQL_SHA256 = '273e571549fc5e12dcd5ce882cd64e801a5008f8492147d49a8afb03743922c8';
export const CANDIDATE = 'scripts/agent-enrollment/migrations/0001_agent_enrollment.sql';
const PROTECTED = Object.freeze({
  'server.ts': 'b60547bda0c88d5f3976cba905ede367b38e9581',
  'src/main.tsx': 'ef12bb11e4796b05c4e57a07af0c1cfeddffedba',
  'src/db/schema.ts': 'cbdfb4e73f93fecc5c7460c63775e179e0bf66cd',
  'src/server/auth/workos-auth.ts': '21e3b48a4c26f88f0ca261657cae9294bce1e287',
  'src/server/agent-enrollment-service.ts': 'bf40133b0ba81149e35defab2586cb401de35d86',
});
const REQUIRED_SOURCE_SNIPPETS = [
  'BEGIN;',
  'REVOKE ALL ON SCHEMA pulse_agent_enrollment FROM PUBLIC',
  'NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS',
  'SECURITY DEFINER SET search_path=pg_catalog,pg_temp',
  'pulse_agent_enrollment.schema_migrations',
  'pulse_agent_enrollment.issue_enrollment',
  'pulse_agent_enrollment.redeem_enrollment',
  'pulse_agent_enrollment.verify_credential',
  'pulse_agent_enrollment.revoke_agent',
  'pulse_agent_enrollment.rotate_credential',
  'FROM PUBLIC, pulse_metrics_app',
  'COMMIT;',
];
function insist(value, why) {
  if (!value) throw new Error(`REFUSE_D9_CANDIDATE: ${why}`);
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function sourceAudit(sqlText) {
  const misses = REQUIRED_SOURCE_SNIPPETS.filter(part => !sqlText.includes(part));
  return { ok: misses.length === 0 && !/\bEXECUTE\s+ON\s+ALL\s+FUNCTIONS\b/i.test(sqlText), misses };
}
export function verifyCandidate(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/agent-enrollment/migrations/manifest.json'), 'utf8'));
  insist(manifest.formatVersion === 1 && manifest.phase === '2E3C5D9' &&
    manifest.kind === 'review-only-privileged-agent-enrollment-migration' &&
    manifest.baselineCommit === EXPECTED_BASELINE &&
    Array.isArray(manifest.steps) && manifest.steps.length === 1,
    'unrecognized candidate manifest');
  insist(manifest.steps[0].version === '0001' && manifest.steps[0].path === CANDIDATE &&
    manifest.steps[0].sha256 === EXPECTED_SQL_SHA256,
    'migration identity or sha256 lock changed');
  const names = readdirSync(resolve(root, 'scripts/agent-enrollment/migrations'))
    .filter(name => /^\d{4}_.*\.sql$/.test(name));
  insist(names.length === 1 && names[0] === '0001_agent_enrollment.sql',
    'unexpected versioned candidate file');
  const bytes = readFileSync(resolve(root, CANDIDATE));
  insist(digest(bytes) === EXPECTED_SQL_SHA256, 'migration SQL bytes changed');
  const checked = sourceAudit(bytes.toString('utf8'));
  insist(checked.ok, 'required fixed SQL security evidence missing');
  // The source pin prevents accidental wiring changes from being hidden by a
  // passing database smoke test. Never use a repository test as release approval.
  for (const [file, blob] of Object.entries(PROTECTED)) {
    insist(git(root, ['hash-object', '--', file]) === blob,
      `reviewed protected source changed: ${file}`);
  }
  insist(git(root, ['merge-base', '--is-ancestor', EXPECTED_BASELINE, 'HEAD']) === '',
    'baseline commit is not an ancestor');
  insist(git(root, ['branch', '--show-current']) === 'feat/identity-organization-onboarding',
    'unexpected branch');
  return { version: '0001', sha256: EXPECTED_SQL_SHA256, restrictedFunctions: 5 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('No arguments permitted');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const verified = verifyCandidate(root);
    console.log(`PASS: immutable enrollment migration ${verified.version} pinned SHA256 ${verified.sha256}`);
    console.log('PASS: original reviewed Git sources are unchanged; no database access');
    console.log('PUBLIC LAUNCH: NO_GO | candidate only, no migration or API activated');
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'REFUSE_D9_CANDIDATE: invalid candidate');
    process.exitCode = 1;
  }
}
