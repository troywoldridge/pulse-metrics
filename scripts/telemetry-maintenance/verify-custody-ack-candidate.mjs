#!/usr/bin/env node
/** D15C-5H read-only, six-source SHA-256 review lock. No file mutation. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const EXPECTED=Object.freeze({
  'README-D15C-5H.md':'7932c94e3b209d78e773d8bf561ef46b589e61e9bf2a45cd9394d149060a15c5',
  'docs/security/D15C-5H-SIGNED-CUSTODY-ACK-DESIGN.md':'aeb318c52a19d11df2093e8b5f17b18cac127dc0ca59974c99acf39b0b951d81',
  'scripts/telemetry-maintenance/custody-ack-contract.mjs':'948e568f6a86ca6f02b706749b5f1e1c6f02ce454c3f00577348dca1b3ffde55',
  'scripts/telemetry-maintenance/custody-ack-contract.test.mjs':'2b64653b576a397186874fef674e6d5afe79f656e17b0bf42723e35afca2cf8c',
  'scripts/telemetry-maintenance/custody-ack-rehearsal.mjs':'3e64622553b5dc9909645b4219b863e3b35c48c46271a4557753f9da713193de',
  'scripts/test-maintenance-signed-custody-ack-rehearsal.sh':'0993e3b649f4efdefc80afcd1c05f15bfb1363f315ccab6d4452bb670fef817d',
});
try {
  if(process.argv.length!==2)throw Error('arguments');
  for(const [path,expected] of Object.entries(EXPECTED)){
    const actual=createHash('sha256').update(readFileSync(resolve(ROOT,path))).digest('hex');
    if(actual!==expected)throw Error('drift');
  }
  console.log('PASS: D15C-5H six new sources pinned SHA256 and unchanged');
  console.log('PUBLIC LAUNCH: NO_GO | synthetic custody and operator decision only');
} catch {
  console.error('REFUSE_D15C5H_SOURCE: source missing or changed');
  process.exitCode=1;
}
