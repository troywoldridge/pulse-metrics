/**
 * D11 read-only source lock. Does not open PostgreSQL, the network or secrets.
 * D10's checked SQL sources must be committed before D11 is applied.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootOfThisPackage = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const lock = JSON.parse(readFileSync(join(rootOfThisPackage, 'scripts/agent-custody/d10-source-lock.json'), 'utf8'));

function requireCondition(ok, message) {
  if (!ok) throw new Error(`REFUSE_D11_FOUNDATION: ${message}`);
}
function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
export function verifyD11Foundation(root = process.cwd(), pins = lock) {
  requireCondition(pins.version === 1 && pins.phase === '2E3C5D11' &&
    pins.parentCommit === '0a128bbd49d302fbb6e4918412d5ba02c895d9d8',
  'unrecognized D11 lock');
  requireCondition(Object.keys(pins.d10FileSha256).length === 13,
    'D10 lock must include 13 reviewed source files');
  for (const [path, expected] of Object.entries(pins.d10FileSha256)) {
    requireCondition(/^[a-zA-Z0-9_./-]+$/.test(path) && !path.includes('..') &&
      typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected), 'invalid D10 source lock');
    requireCondition(existsSync(join(root, path)) &&
      digest(readFileSync(join(root, path))) === expected, `reviewed D10 source changed: ${path}`);
  }
  for (const path of Object.keys(pins.protectedGitBlobs)) {
    requireCondition(existsSync(join(root, path)), `protected source missing: ${path}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  requireCondition(pkg.scripts?.test === 'node scripts/run-all-tests.mjs' &&
    existsSync(join(root, 'scripts/run-all-tests.mjs')),
  'recursive TypeScript test discovery is not committed');
  const server = readFileSync(join(root, 'server.ts'), 'utf8');
  requireCondition(!/create(Issue|Redeem)AgentEnrollmentRoute|agentEnrollmentIngressVerified/.test(server),
    'public enrollment route has been wired');
  const agent = readFileSync(join(root, 'src/agent/run-linux-agent.ts'), 'utf8');
  requireCondition(!/installMachineCredential|readMachineCredential|rotateMachineCredential/.test(agent),
    'agent runner was unexpectedly changed to load credentials');
  return { d10PinnedFiles: Object.keys(pins.d10FileSha256).length,
    recursiveTests: true, publicEnrollment: 'UNMOUNTED', agentConnectivity: 'LOCAL_ONLY' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyD11Foundation();
    console.log(`PASS: ${result.d10PinnedFiles} immutable D10 sources and recursive test runner verified`);
    console.log('PASS: enrollment routes are UNMOUNTED; agent runner remains LOCAL_ONLY');
    console.log('PUBLIC LAUNCH: NO_GO — D11 has no network/credential-issuance capability');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'D11 verification unavailable');
    process.exitCode = 1;
  }
}
