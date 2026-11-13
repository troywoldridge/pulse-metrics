#!/usr/bin/env node

/**
 * D15B — verified SQL artifact emitter.
 *
 * READ-ONLY local file operation.
 * No PostgreSQL connection, environment loading, or deployment approval.
 *
 * Intended exclusively for the marker-verified disposable rehearsal.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyCandidate,
  EXPECTED_SHA256,
  CANDIDATE,
} from './verify-candidate.mjs';

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
);

function refuse(reason) {
  throw new Error(`REFUSE_D15B_SQL_EMITTER: ${reason}`);
}

async function main() {
  if (process.argv.length !== 2) {
    refuse('unexpected arguments');
  }

  // Capture the bytes that will actually be emitted.
  const bytes = readFileSync(resolve(ROOT, CANDIDATE));

  const digest = createHash('sha256')
    .update(bytes)
    .digest('hex');

  if (digest !== EXPECTED_SHA256) {
    refuse('SQL artifact fingerprint mismatch');
  }

  // Independently verify the manifest and expected migration version.
  const verified = verifyCandidate(ROOT);

  if (
    verified.version !== '0001' ||
    verified.sha256 !== digest ||
    verified.path !== CANDIDATE
  ) {
    refuse('migration identity mismatch');
  }

  // stdout is reserved exclusively for verified SQL bytes.
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(bytes, error => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

main().catch(error => {
  console.error(
    error instanceof Error
      ? error.message
      : 'REFUSE_D15B_SQL_EMITTER: verification failed'
  );
  process.exitCode = 1;
});
