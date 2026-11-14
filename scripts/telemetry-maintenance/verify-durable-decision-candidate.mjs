#!/usr/bin/env node
/** D15C-5I: independently pinned sources, read-only; no database or network. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'README-D15C-5I.md': 'e5cdcb3ed25526d165575e493c3e3b0e4b80da505079f2616c560dabd5eece39',
  'docs/security/D15C-5I-PERSISTENT-REPLAY-CUSTODY-DESIGN.md': 'b6a069532d77a76ab514c892a4f561f60b907e6658d11b1dfa9f313da1f390c3',
  'scripts/telemetry-maintenance/durable-decision-ledger.mjs': '14ee2eee95a5ba4cb44601506455177f4bd9d431e3443d88e611e3364910f7e1',
  'scripts/telemetry-maintenance/durable-decision-ledger.test.mjs': 'd43cc921e937b1d4a8d8ff58cd3b3b7dc7b34fe7d7c8a5b66d2ae8075cfed41f',
  'scripts/telemetry-maintenance/durable-decision-rehearsal.mjs': '5211d1de4c1035600075b6563aefc2153bcc93094346b48ff4ea2f5923634c1a',
  'scripts/test-maintenance-durable-decision-rehearsal.sh': 'f66182c230b8046ce551a48f2acb20c352b0d9428592704bc0f00c9e94fc32c1'
});
try {
  if (process.argv.length !== 2) throw Error('unexpected_arguments');
  for (const [path, expected] of Object.entries(EXPECTED)) {
    const actual = createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
    if (actual !== expected) throw Error('source_changed');
  }
  console.log('PASS: D15C-5I source hashes verified; prior 5H contract remains pinned');
  console.log('PUBLIC LAUNCH: NO_GO | synthetic local replay ledger and checkpoint only');
} catch {
  console.error('REFUSE_D15C5I_SOURCE: reviewed source changed or unavailable');
  process.exitCode = 1;
}
