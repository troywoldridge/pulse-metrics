#!/usr/bin/env node
/** D15C-5K purely offline review, no network or database imports. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_SHORTLIST, inspectPlatformShortlist,
  inspectCostScenario, guardPlatformReview,
} from './platform-shortlist-contract.mjs';
import {
  PROPOSED_BOUNDARIES, inspectReleaseGateRegister,
  reviewProposedBoundaries, reviewRecoveryAction,
} from './production-security-boundary.mjs';

try {
  // Refuse live settings before opening any file.
  guardPlatformReview(process.env, process.argv.length);
} catch {
  console.error('D15C5K_REVIEW {"event":"configuration_denied","authorized":false}');
  process.exit(1);
}

try {
  const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const manifest=JSON.parse(readFileSync(resolve(root,
    'docs/security/D15C-5K-PLATFORM-SHORTLIST.json'),'utf8'));
  const register=JSON.parse(readFileSync(resolve(root,
    'docs/security/D15C-5J-RELEASE-GATE-REGISTER.json'),'utf8'));
  if (inspectPlatformShortlist(manifest).decision !== 'external_review_required' ||
      inspectReleaseGateRegister(register).decision !== 'blocked' ||
      reviewProposedBoundaries(PROPOSED_BOUNDARIES).decision !== 'review_required') {
    throw Error('source_inventory_invalid');
  }
  if (JSON.stringify(manifest) !== JSON.stringify(FIXED_SHORTLIST)) {
    throw Error('manifest_different_from_locked_contract');
  }
  if (inspectPlatformShortlist(manifest).candidate !== 'self_host_existing_server_pilot' ||
      inspectCostScenario(manifest,'self_host_existing_server_pilot').decision !== 'unquantified_existing_hardware' ||
      inspectCostScenario(manifest,'self_host_existing_server_pilot').subtotalUsd !== null ||
      inspectCostScenario(manifest,'do_basic_managed_pg').subtotalUsd !== 39 ||
      inspectCostScenario(manifest,'render_2g_managed_pg').subtotalUsd !== 44 ||
      inspectCostScenario(manifest,'do_ha_database_scenario').subtotalUsd !== 84) {
    throw Error('unexpected_budget');
  }
  const forged = structuredClone(manifest);
  forged.productionAuthorized=true;
  if (inspectPlatformShortlist(forged).decision !== 'rejected') throw Error('unsafe_acceptance');
  const downgraded = structuredClone(manifest);
  downgraded.options[0].tlsMode='require';
  if (inspectPlatformShortlist(downgraded).decision !== 'rejected') throw Error('tls_downgrade');
  for (const state of ['in_flight','unknown']) {
    const action=reviewRecoveryAction({sourceState:state,action:'automatic_retry'});
    if (action.decision !== 'denied' || action.performed !== false) throw Error('replay');
  }
  console.log('PASS: D15C-5K original 5J architecture and 16 blocked launch gates preserved');
  console.log('PASS: existing owner-operated server is conditional private pilot; hosting cost UNKNOWN');
  console.log('PASS: legacy PostgreSQL allowlist, shared hardware and restore gaps remain unresolved');
  console.log('PASS: DigitalOcean $39 base retained as non-HA alternative, not selected');
  console.log('PASS: Render $44 comparison remains blocked on 5J internal database TLS requirement');
  console.log('PASS: TLS downgrade, forged vendor approval and ambiguous delivery replay refused');
  console.log('PASS: source inventory cannot authorize cloud account, cost or infrastructure action');
  console.log('D15C-5K OFFLINE SELF-HOSTING AND PROVIDER FALLBACK REVIEW PASSED');
  console.log('PUBLIC LAUNCH: NO_GO | no provider accepted, no resources provisioned');
} catch {
  console.error('REFUSE_D15C5K_REVIEW: offline inventory or security contract changed');
  process.exitCode=1;
}
