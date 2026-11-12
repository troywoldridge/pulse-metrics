/** Read-only Phase 2E3C5D12 immutable source and route-mount guard. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownRoot = fileURLToPath(new URL('../../', import.meta.url));
const ownLockPath = resolve(ownRoot, 'scripts/agent-https/d11-source-lock.json');
const lock = JSON.parse(readFileSync(ownLockPath, 'utf8'));
const disallowed = /(^|\/)\.\.(\/|$)|\\/;
function demand(ok, message) {
  if (!ok) throw new Error(`REFUSE_D12_FOUNDATION: ${message}`);
}
function gitBlob(buffer) {
  const size = Buffer.byteLength(buffer);
  return createHash('sha1').update(`blob ${size}\0`).update(buffer).digest('hex');
}
export function verifyD12Foundation(root = process.cwd(), pins = lock) {
  demand(pins?.formatVersion === 1 && pins.phase === '2E3C5D12' &&
    pins.parentCommit === '7526b15f085c27d8234b875ae9cc525c5ad6acff' &&
    pins.publicEnrollment === 'UNMOUNTED' && pins.agentTelemetryTransport === 'LOCAL_ONLY' &&
    pins.expectedTestCommand === 'node scripts/run-all-tests.mjs', 'invalid reviewed lock');
  const entries = Object.entries(pins.protectedGitBlobs ?? {});
  demand(entries.length === 11, 'missing independent protected source pins');
  for (const [path, digest] of entries) {
    demand(typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) &&
      !disallowed.test(path) && !path.startsWith('/') &&
      typeof digest === 'string' && /^[a-f0-9]{40}$/.test(digest), 'invalid protected path/hash');
    const target = join(root, path);
    demand(existsSync(target) && gitBlob(readFileSync(target)) === digest, `protected source drifted: ${path}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  demand(pkg?.scripts?.test === 'node scripts/run-all-tests.mjs', 'recursive test discovery was removed');
  const server = readFileSync(join(root, 'server.ts'), 'utf8');
  const agent = readFileSync(join(root, 'src/agent/run-linux-agent.ts'), 'utf8');
  demand(!/create(Issue|Redeem)AgentEnrollmentRoute|agentEnrollmentIngressVerified/.test(server),
    'enrollment route unexpectedly active');
  demand(!/redeemEnrollmentOverVerifiedHttps|redeemAndInstallVerifiedMachineIdentity/.test(agent),
    'Linux telemetry runner was wired to enrollment');
  return { protectedSources: entries.length, publicEnrollment: 'UNMOUNTED', agentTransport: 'LOCAL_ONLY' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const status = verifyD12Foundation();
    console.log(`PASS: ${status.protectedSources} immutable reviewed Git blobs; source remains unchanged`);
    console.log('PASS: recursive tests, unmounted enrollment endpoints, LOCAL_ONLY telemetry runner');
    console.log('PUBLIC LAUNCH: NO_GO — no production endpoint or agent enrollment activation');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'D12 source verification unavailable');
    process.exitCode = 1;
  }
}
