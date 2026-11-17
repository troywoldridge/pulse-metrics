#!/usr/bin/env node
// 2F2J strictly offline reviewer: no database, networking, signing or writes.
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareSignedIdentityEvidence, parseIdentityEvidence } from './pilot-identity-evidence.mjs';

function refuse() { throw new Error('REFUSE_D15C5U2F2J: review denied'); }
function file(path, limit) {
  if (typeof path !== 'string' || !isAbsolute(path)) refuse();
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size < 1 || st.size > limit) refuse();
  return readFileSync(path, 'utf8');
}
export function run(args) {
  if (args.length === 1 && args[0] === '--plan') {
    process.stdout.write([
      '========== D15C-5U-2F2J LIVE IDENTITY PROOF PLAN ==========',
      '2F2I signed identities and 2F2J one-owner/one-agent SQL facts are separate proofs.',
      'No signer or signed identity manifest is established by this package.',
      '2F2J SQL is for an EXISTING disposable 55432 private PostgreSQL instance only.',
      'Do not point at the protected 55433 database; 2F2H stays EMPTY ONLY.',
      'Offline evidence checks never attest a live database or authorize any write.',
      'NO POSTGRESQL START | NO ENROLLMENT | NO WRITES | PUBLIC LAUNCH: NO_GO',
    ].join('\n') + '\n');
    return;
  }
  if (args.length === 2 && args[0] === '--check-offline-evidence') {
    parseIdentityEvidence(file(args[1], 16384));
    process.stdout.write('PASS: offline identity evidence SHAPE only; DATABASE NOT ATTESTED\n');
    return;
  }
  if (args.length === 5 && args[0] === '--compare-signed-offline') {
    const raw = file(args[1], 8192);
    const key = file(args[2], 8192);
    const evidence = parseIdentityEvidence(file(args[4], 16384)).evidence;
    compareSignedIdentityEvidence(raw, key, args[3], evidence);
    process.stdout.write('PASS: signed OFFLINE identity comparison; NO RUNTIME AUTHORIZATION\n');
    return;
  }
  refuse();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run(process.argv.slice(2)); }
  catch { process.stderr.write('REFUSE_D15C5U2F2J: review denied\n'); process.exitCode = 1; }
}
