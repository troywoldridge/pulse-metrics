#!/usr/bin/env node
// Pulse Metrics D15C-5U-2F2H — consume one reviewed read-only SQL snapshot.
// The empty-only authorization is hardcoded for this stage. No file-supplied
// policy, client-chosen tenant, unrestricted selector or write approval exists.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assessPilotInventory } from './pilot-inventory-policy.mjs';

export function verifyEmptySnapshotText(raw) {
  if (typeof raw !== 'string' || raw.length > 16384 || raw.length < 40) {
    throw new Error('REFUSE_D15C5U2F2H: invalid inventory byte count');
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}') || trimmed.includes('\n')) {
    throw new Error('REFUSE_D15C5U2F2H: expected one JSON inventory record');
  }
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch { throw new Error('REFUSE_D15C5U2F2H: invalid inventory JSON'); }
  const decision = assessPilotInventory(parsed, { version: 1, mode: 'empty' });
  if (decision.mode !== 'empty' || decision.sampleCount !== 0 || decision.agentCount !== 0) {
    throw new Error('REFUSE_D15C5U2F2H: inventory policy decision incorrect');
  }
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--empty-stdin') {
      throw new Error('REFUSE_D15C5U2F2H: expected exactly --empty-stdin');
    }
    const input = readFileSync(0, { encoding: 'utf8' });
    verifyEmptySnapshotText(input);
    process.stdout.write('PASS: exact read-only PostgreSQL inventory satisfies empty pilot policy; no secrets emitted\n');
  } catch (e) {
    const safe = e instanceof Error && e.message.startsWith('REFUSE_')
      ? e.message : 'REFUSE_D15C5U2F2H: inventory or policy verification failed';
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  }
}
