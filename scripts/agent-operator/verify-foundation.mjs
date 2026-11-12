/** D14 read-only immutable baseline and public-activation safety guard. */
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const lock = JSON.parse(readFileSync(join(packageRoot, 'scripts/agent-operator/d13-source-lock.json'), 'utf8'));

function demand(value, message) {
  if (!value) throw new Error(`REFUSE_D14_FOUNDATION: ${message}`);
}
function gitBlob(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}
function file(root, path) {
  demand(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) &&
    !path.startsWith('/') && !path.split('/').includes('..'), 'unsafe source path');
  const target = join(root, path);
  const stat = lstatSync(target);
  demand(stat.isFile() && !stat.isSymbolicLink(), `protected file unsafe: ${path}`);
  return readFileSync(target);
}
export function verifyD14Foundation(root = process.cwd(), pins = lock) {
  demand(pins?.formatVersion === 1 && pins.phase === '2E3C5D14' &&
    pins.parentCommit === '2f3f6dc61951fd61aa3d63466344295b5e197794' &&
    pins.release === 'REVIEW_ONLY' && pins.publicLaunch === 'NO_GO' &&
    pins.expectedTestCommand === 'node scripts/run-all-tests.mjs', 'unrecognized source lock');
  const entries = Object.entries(pins.protectedGitBlobs ?? {});
  demand(entries.length === 17, 'incomplete D13 source pin list');
  for (const [path, digest] of entries) {
    demand(typeof digest === 'string' && /^[0-9a-f]{40}$/.test(digest), 'invalid Git blob hash');
    demand(gitBlob(file(root, path)) === digest, `historical source changed: ${path}`);
  }
  demand(createHash('sha256').update(file(root,
    'scripts/agent-identity/migrations/0003_preallocated_identity.sql')).digest('hex') ===
    pins.d13SqlSha256 && pins.d13SqlSha256 ===
    'c085dd674581abe6a636de8cd586e43de745d35ee965c0e141f8dc4015d3b406',
    'D13 migration candidate was changed');
  const pkg = JSON.parse(file(root,'package.json').toString('utf8'));
  demand(pkg.scripts?.test === 'node scripts/run-all-tests.mjs', 'test discovery changed');
  const server = file(root, 'server.ts').toString('utf8');
  const runner = file(root,'src/agent/run-linux-agent.ts').toString('utf8');
  demand(!/createIssueAgentEnrollmentRoute|createRedeemAgentEnrollmentRoute|createIssuePreallocatedEnrollmentRoute|createRedeemPreallocatedEnrollmentRoute/.test(server), 'public enrollment route mounted');
  demand(!/operator-cli|enrollWithOperatorToken|redeemAndInstallVerifiedMachineIdentity/.test(runner), 'telemetry runner was coupled to enrollment');
  const cli = file(root,'src/agent/enrollment/operator-cli.ts').toString('utf8');
  const input = file(root,'src/agent/enrollment/operator-token-input.ts').toString('utf8');
  demand(!/\bprocess\.env\b/.test(cli + input) && !/rejectUnauthorized\s*:\s*false/.test(cli + input),
    'CLI introduced environment secret or disabled TLS checks');
  return {historicalFiles: entries.length, publicLaunch:'NO_GO', agentTransport:'LOCAL_ONLY'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyD14Foundation();
    console.log(`PASS: ${result.historicalFiles} immutable D13 and earlier Git blobs unchanged`);
    console.log('PASS: reviewed D13 SQL unchanged; enrollment routes UNMOUNTED; Linux agent LOCAL_ONLY');
    console.log('PUBLIC LAUNCH: NO_GO — D14 operator tool is opt-in only');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'D14 verification unavailable');
    process.exitCode = 1;
  }
}
