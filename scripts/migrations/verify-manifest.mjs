// Phase 2E3C5C1: immutable *reviewed* privileged SQL source manifest.
// Read-only: never connects to PostgreSQL or loads .env.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEWED = Object.freeze([
  ['001', 'workos_identity_provisioning', '14f261b4bf7802a92e4c15d7f67cb563ad755fdf2bc4bcc1b7e39b8ad1d8aab7', 'public.resolve_workos_user(text)'],
  ['002', 'organization_onboarding', '89a0251114f1839fb8449c41f62cb8c4f2d197a34155595746b66bd183c785dc', 'public.create_workos_organization(text,text,text)'],
  ['003', 'organization_invitations', 'c07bb1a17375eb8b9522092b1d23a5f6aa4a21571c6e590aa34b3f0b27410e42', 'public.issue_organization_invitation(text,uuid,text,text,text,timestamptz)'],
  ['004', 'organization_invitation_acceptance', 'd34fe9b8de7cec1e9109caefa7f33879f55188f00f051c8e2efb81d3bc4d4c9f', 'public.accept_organization_invitation(text,text)'],
  ['005', 'workos_verified_email_sync', '0bf20d0d11ad87505e7a0f58b61b85c6bb26413baef925c34da1b209c4476121', 'public.sync_workos_verified_email(text,text)'],
  ['006', 'invitation_rate_limits', '597be8dfd60cff05947a1511f5ff6853bed6601b5e62bf9164f24f4943b33327', 'public.consume_invitation_rate_limit(text,text,text)'],
]);
const DRIZZLE = Object.freeze([
  ['migration', 'drizzle/0000_damp_tomorrow_man.sql', 'd49e23396a343852627ceab778521adaefc6382c2be6111bf83bf3e59ad870e1'],
  ['journal', 'drizzle/meta/_journal.json', 'ae17ed491915e7870467d73ca34cf9ac7c6d6157cc621986ceb3bf60999af26e'],
]);
const EXPECTED_COMMIT = 'dbc00026c5f3820e04ff3eee4946d1b985b0e635';

function insist(condition, reason) {
  if (!condition) throw new Error(`Privileged SQL manifest refused: ${reason}`);
}
function sourceHash(root, source) {
  return createHash('sha256').update(readFileSync(resolve(root, source))).digest('hex');
}

/** Check source bytes against both the manifest and an independent reviewed lock. */
export function verifyManifest(root = process.cwd()) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/migrations/privileged-manifest.json'), 'utf8'));
  insist(manifest?.formatVersion === 1 && manifest.kind === 'pulse-privileged-admin-sql' &&
    manifest.database === 'pulse_metrics' && manifest.sourceBaselineCommit === EXPECTED_COMMIT,
    'unrecognized manifest format, target or source baseline');
  insist(Array.isArray(manifest.steps) && manifest.steps.length === REVIEWED.length,
    'expected exactly six ordered administrator steps');
  insist(manifest.drizzle && typeof manifest.drizzle === 'object', 'missing Drizzle source lock');
  for (const [kind, path, digest] of DRIZZLE) {
    insist(manifest.drizzle[kind]?.path === path && manifest.drizzle[kind]?.sha256 === digest,
      `reviewed Drizzle ${kind} lock changed`);
    insist(sourceHash(root, path) === digest, `Drizzle ${kind} source bytes differ`);
  }
  for (let i = 0; i < REVIEWED.length; i++) {
    const [version, name, digest, expectedFunction] = REVIEWED[i];
    const step = manifest.steps[i];
    const path = `scripts/admin/${version}_${name}.sql`;
    insist(step?.version === version && step?.name === name && step?.path === path &&
      step?.sha256 === digest && step?.expectedFunction === expectedFunction,
      `unreviewed, reordered or modified step ${version}`);
    insist(sourceHash(root, path) === digest, `administrator SQL ${version} changed`);
  }
  const sqlFiles = readdirSync(resolve(root, 'scripts/admin'))
    .filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
  const expectedFiles = REVIEWED.map(([n, name]) => `${n}_${name}.sql`);
  insist(JSON.stringify(sqlFiles) === JSON.stringify(expectedFiles),
    'untracked or missing numbered administrator SQL file');
  return manifest.steps;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    insist(process.argv.length <= 3, 'unexpected arguments');
    insist(!process.argv[2] || process.argv[2] === '--tsv', 'unknown command');
    const steps = verifyManifest();
    if (process.argv[2] === '--tsv') {
      // Caller must NOT use the TSV without first checking this command exits 0.
      for (const s of steps) process.stdout.write(`${s.version}\t${s.path}\t${s.sha256}\n`);
    } else {
      console.log('PASS: original Drizzle source and all six ordered privileged SQL sources match the independent reviewed manifest');
      console.log('NOTE: no database connection or changes were made');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid privileged SQL manifest');
    process.exitCode = 1;
  }
}
