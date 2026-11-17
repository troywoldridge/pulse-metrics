#!/usr/bin/env node
// Pulse Metrics 2F2I — offline-only review tool. Never signs an authorization,
// starts PostgreSQL, derives identities from DB rows or enables telemetry.
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCanonicalJSON, validatePilotManifest, verifySignedPilotApproval } from './pilot-authorization-policy.mjs';

function refuse() { throw new Error('REFUSE_D15C5U2F2I: offline request refused'); }
function safeRead(path, maxBytes) {
  if (typeof path !== 'string' || !isAbsolute(path)) refuse();
  const stat = lstatSync(path, { bigint: false });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) refuse();
  return readFileSync(path, 'utf8');
}
function plan() {
  process.stdout.write([
    '========== D15C-5U-2F2I INDEPENDENT PILOT IDENTITY PLAN ==========',
    'This tool validates a canonical, explicit one-organization, one-agent request.',
    'An optional Ed25519 signature requires an independently reviewed public-key digest.',
    'No signer, key, organization, agent or owner user is preauthorized by this package.',
    'The 2F2H live SQL path is EMPTY ONLY; this tool never connects to PostgreSQL.',
    'Signed fixture assessments do NOT prove live tenant owner membership.',
    'NO AGENT ENROLLMENT | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO',
  ].join('\n') + '\n');
}
export function run(args) {
  if (args.length === 1 && args[0] === '--plan') { plan(); return; }
  if (args.length === 2 && args[0] === '--check-draft') {
    const proposal = parseCanonicalJSON(safeRead(args[1], 8192), 'unsigned request');
    validatePilotManifest(proposal);
    process.stdout.write('PASS: canonical unsigned request shape only; NOT AN APPROVAL\n');
    return;
  }
  if (args.length === 4 && args[0] === '--review-signed-offline') {
    const proposal = safeRead(args[1], 8192);
    const keyPem = safeRead(args[2], 8192);
    verifySignedPilotApproval(proposal, keyPem, args[3]);
    process.stdout.write('PASS: signed manifest review only; NO RUNTIME AUTHORIZATION\n');
    return;
  }
  refuse();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run(process.argv.slice(2)); }
  catch { process.stderr.write('REFUSE_D15C5U2F2I: offline review denied\n'); process.exitCode = 1; }
}
