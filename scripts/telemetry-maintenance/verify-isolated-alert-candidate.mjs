#!/usr/bin/env node
/**
 * D15C-5F read-only full-source review manifest. No network, DB or writes.
 * The predecessor D15C-5D/E verifiers are invoked separately by the launcher.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expected = Object.freeze({
  'README-D15C-5F.md':
    '9edf4c28976c537797f40b1dc4d5c7d436c12a6bf03b69f8326478ec6629cf0f',
  'docs/security/D15C-5F-ISOLATED-ALERT-HANDOFF-DESIGN.md':
    'b5634372d104b412ee0089c1591de908df80b64d3936e85c826907cada61acfc',
  'scripts/telemetry-maintenance/isolated-alert-handoff.mjs':
    'd57aaf1cc3fef277b513548b501415e6d053f2077b128039c72a61dea9afcc3c',
  'scripts/telemetry-maintenance/isolated-alert-handoff.test.mjs':
    'c04f856bbb3a1f4e6de2e233c439476a1635b77123e45c00e4640b551ea28416',
  'scripts/telemetry-maintenance/isolated-alert-rehearsal.mjs':
    'f1f14832e08cc8a2a95ebce615a5b4ae44609ef128df60d65a7aa82a49c98565',
  'scripts/test-maintenance-isolated-alert-rehearsal.sh':
    '2764a5a28e40b881001604d3f950d423d7897f9a9ec4de84c125454b3742f704',
});
try {
  if (process.argv.length !== 2) throw Error('arguments_refused');
  for (const [file, hash] of Object.entries(expected)) {
    const actual = createHash('sha256')
      .update(readFileSync(resolve(root, file))).digest('hex');
    if (actual !== hash) throw Error('source_changed');
  }
  console.log('PASS: D15C-5F six complete source files match SHA-256 review pins');
  console.log('PUBLIC LAUNCH: NO_GO | local fake receiver only');
} catch {
  console.error('REFUSE_D15C5F_SOURCE: missing or changed reviewed file');
  process.exitCode = 1;
}
