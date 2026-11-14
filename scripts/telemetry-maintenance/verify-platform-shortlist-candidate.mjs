#!/usr/bin/env node
/** D15C-5K: independently pinned REVIEW snapshots; no network or DB. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED=Object.freeze({
  'README-D15C-5K.md': '4fec7b147afe78e37dbde341c5f7a5495010c90034415306adceaf33213a254a',
  'docs/architecture/ADR-011-PLATFORM-SELECTION-SHORTLIST.md': '1200956400c64cde40c2cb9cb1f2125a2855625bdb8b77f137ea2a0a0ed410f7',
  'docs/operations/D15C-5K-BUDGET-AND-ROLLBACK-PLANNING.md': '87397ddc6a75435dd86286a97d7d6bddf6208679b683009733f3e29797581eb8',
  'docs/security/D15C-5K-PROVIDER-DUE-DILIGENCE.md': '5c69a72fa77e5283798228b7ed9b156287a4af1d8d4de4b2eb8e54a8b6f1abce',
  'docs/security/D15C-5K-PLATFORM-SHORTLIST.json': '08faaab296edeb671cc32addac9c3a14c12d2595fc885c281100380a27a65c7e',
  'scripts/telemetry-maintenance/platform-shortlist-contract.mjs': 'afb5bbdebe804390468a56270914f0f9017e0d4e26550276ac985813b709d5c7',
  'scripts/telemetry-maintenance/platform-shortlist-contract.test.mjs': 'cc5b00b14ffc589a21bbc4d2e7a15fad22c4470a78011019d152c065f15d1149',
  'scripts/telemetry-maintenance/platform-shortlist-rehearsal.mjs': '5daf379834d0918a50eb05363aba7bb6b411b7031664c125edeff78eecff041c',
  'scripts/test-maintenance-platform-shortlist.sh': '1a6f19f81183405ddfd75be1706019bff5f1c50570b311b579d4b6939b56f350',
});
try {
  if (process.argv.length !== 2) throw Error('unexpected_arguments');
  for (const [relative, expected] of Object.entries(EXPECTED)) {
    const actual=createHash('sha256').update(readFileSync(resolve(ROOT,relative))).digest('hex');
    if (actual !== expected) throw Error('source_modified');
  }
  console.log('PASS: D15C-5K self-host and fallback sources match reviewed SHA256');
  console.log('PUBLIC LAUNCH: NO_GO | conditional private pilot only, no deployment');
} catch {
  console.error('REFUSE_D15C5K_SOURCE: source changed or unreadable');
  process.exitCode=1;
}
