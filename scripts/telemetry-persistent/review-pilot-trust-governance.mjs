#!/usr/bin/env node
// D15C-5U-2F2M — offline review CLI; cannot create keys or approve operations.
import { openSync, readFileSync, fstatSync, closeSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assessTwoPersonPilotReview } from './pilot-trust-governance.mjs';

function refuse() { throw new Error('REFUSE_D15C5U2F2M: governance review denied'); }
function readOwnerOnlyRegularFile(path, maxSize) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\u0000')) refuse();
  // O_NOFOLLOW + fstat on the *opened descriptor* prevents final-component
  // symlink swaps between checking a path and reading its content.
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maxSize) refuse();
    const content = readFileSync(fd, { encoding:'utf8' });
    if (Buffer.byteLength(content,'utf8') !== stat.size) refuse();
    return content;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--plan') {
    process.stdout.write([
      '========== D15C-5U-2F2M INDEPENDENT TRUST GOVERNANCE PLAN ==========',
      'Root Ed25519 public-key digest and minimum signed-roster serial MUST be independently pinned.',
      'A root-signed roster identifies distinct pilot-signer and independent-reviewer public keys.',
      'Both signatures must match the SAME canonical 2F2I proposal and current bounded review window.',
      'Signed revocation blocks its key; external custody and newest revocation MUST be checked independently.',
      'No root key, approval authority, private signer key, real reviewer, or operational authorization is supplied.',
      'NO POSTGRESQL | NO ENROLLMENT | NO KEY GENERATION | NO PERSISTENT WRITES | PUBLIC LAUNCH: NO_GO',
      '',
    ].join('\n'));
  } else if (process.argv.length === 9 && process.argv[2] === '--review-offline') {
    const [,,, rootFile, registryFile, proposalFile, reviewFile, pinnedRootHash, minSerial] = process.argv;
    const serial = Number(minSerial);
    if (!/^[1-9][0-9]{0,8}$/.test(minSerial) || !Number.isSafeInteger(serial)) refuse();
    const result = assessTwoPersonPilotReview({
      rootPublicPem: readOwnerOnlyRegularFile(rootFile,4096),
      rawRegistry: readOwnerOnlyRegularFile(registryFile,8192),
      rawApproval: readOwnerOnlyRegularFile(proposalFile,8192),
      rawReviewerAttestation: readOwnerOnlyRegularFile(reviewFile,8192),
      pinnedRootFingerprint: pinnedRootHash, minimumSerial: serial,
    });
    if (!result.reviewOnly || result.operationalAuthorization) refuse();
    process.stdout.write('PASS: three signatures and independent-role trust contract verified OFFLINE; NO AUTHORIZATION\n');
  } else {
    refuse();
  }
} catch {
  process.stderr.write('REFUSE_D15C5U2F2M: offline governance check denied; NO AUTHORIZATION\n');
  process.exitCode = 1;
}
