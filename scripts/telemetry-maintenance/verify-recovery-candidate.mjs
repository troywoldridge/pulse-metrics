#!/usr/bin/env node
/**
 * D15C-5G offline source-lock verifier. No DB, HTTP or file modifications.
 * Checks the independently recorded full SHA256 bytes of every other 5G file.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'README-D15C-5G.md':
    '11310eee569737301c1db463bef86e980413948aca860101bb2e9f4502bdaf59',
  'docs/security/D15C-5G-RECOVERY-WITNESS-DESIGN.md':
    '5d0808f8767d7e4a06bdbd0845eb017f54add0875040896962e76cec60902fe3',
  'scripts/telemetry-maintenance/alert-recovery-anchor.mjs':
    '63656fcf77be3ebcf14a1c81d5d97c0b53a3210b34472e835df53e1095da2781',
  'scripts/telemetry-maintenance/alert-recovery-anchor.test.mjs':
    '5f5147b03fb1c30773166ed7aa77ac53792a5aa0c8fad32b98050f6d27080059',
  'scripts/telemetry-maintenance/alert-recovery-rehearsal.mjs':
    'ab7b8e7d59ef96725ce042f28d5cbad465843f7020a3e8b28751470da109ee94',
  'scripts/test-maintenance-alert-recovery-rehearsal.sh':
    '9d55f7008f9040de6cf5e0f9f8205e1c60ba9e1415e3388c016481a1c882dc2f',
});
try {
  if (process.argv.length !== 2) throw Error('unexpected arguments');
  for (const [file, expected] of Object.entries(EXPECTED)) {
    const actual = createHash('sha256').update(readFileSync(resolve(ROOT,file))).digest('hex');
    if (actual !== expected) throw Error('source changed');
  }
  console.log('PASS: D15C-5G six full new sources match reviewed SHA-256 pins');
  console.log('PUBLIC LAUNCH: NO_GO | local witness and manual recovery review only');
} catch {
  console.error('REFUSE_D15C5G_SOURCE: candidate changed or unavailable');
  process.exitCode = 1;
}
