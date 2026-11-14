#!/usr/bin/env node
/** D15C-5J — OFFLINE architecture review only; NO network, DB, IAM or send. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ARCHITECTURE_REVIEW, PROPOSED_BOUNDARIES,
  reviewProposedBoundaries, inspectReleaseGateRegister,
  reviewRecoveryAction, guardArchitectureRehearsal,
} from './production-security-boundary.mjs';
import { CONTRACT } from './operator-alert-contract.mjs';
import { CUSTODY_ACK } from './custody-ack-contract.mjs';
import { DURABLE_DECISION } from './durable-decision-ledger.mjs';

const DENY = 'D15C5J_REVIEW {"event":"configuration_denied","authorized":false}';
try {
  guardArchitectureRehearsal(process.env, process.argv.length);
} catch {
  console.log(DENY);
  process.exit(1);
}
try {
  if (ARCHITECTURE_REVIEW.publicLaunch !== 'NO_GO' ||
      ARCHITECTURE_REVIEW.productionAuthorized !== false ||
      CONTRACT.productionAuthorization !== false ||
      CUSTODY_ACK.productionAuthorized !== false ||
      DURABLE_DECISION.productionAuthorized !== false ||
      DURABLE_DECISION.automaticReplayAuthorized !== false ||
      DURABLE_DECISION.independentExternalCustody !== false) {
    throw Error('predecessor_capability_violation');
  }
  const data = readFileSync(fileURLToPath(new URL(
    '../../docs/security/D15C-5J-RELEASE-GATE-REGISTER.json', import.meta.url)), 'utf8');
  const gates = JSON.parse(data);
  const blueprint = reviewProposedBoundaries(JSON.parse(JSON.stringify(PROPOSED_BOUNDARIES)));
  const evidence = inspectReleaseGateRegister(gates);
  if (blueprint.decision !== 'review_required' || blueprint.productionAuthorized !== false ||
      evidence.decision !== 'blocked' || evidence.gateCount !== 16 ||
      evidence.externallyVerifiedGates !== 0) {
    throw Error('release_gate_violation');
  }
  const forbiddenActions = ['automatic_retry','send_again','mark_human_acknowledged',
    'approve_production','grant_database_role'];
  for (const sourceState of ['in_flight','unknown','queued','transport_accepted']) {
    for (const action of forbiddenActions) {
      const result = reviewRecoveryAction({sourceState,action});
      if (result.decision !== 'denied' || result.performed !== false)
        throw Error('unsafe_transition');
    }
  }
  // These are IN-MEMORY negative probes, not changes to actual deployment settings.
  const unsafe = JSON.parse(JSON.stringify(PROPOSED_BOUNDARIES));
  unsafe.workloads.maintenance.databaseRole='pulse_metrics_app';
  if (reviewProposedBoundaries(unsafe).decision !== 'rejected')
    throw Error('shared_role_admitted');
  const fakeProof = JSON.parse(JSON.stringify(gates));
  fakeProof.gates[0].status='passed';
  if (inspectReleaseGateRegister(fakeProof).decision !== 'rejected')
    throw Error('fake_release_accepted');

  console.log('PASS: D15C-5J committed 5E/5H/5I zero-live capability invariants preserved');
  console.log('PASS: proposed API, ingress, maintenance, custody and operator boundaries distinct');
  console.log('PASS: sixteen release requirements remain unverified; source JSON cannot approve deployment');
  console.log('PASS: shared database role, fake approval and untrusted evidence refused');
  console.log('PASS: all automatic ambiguous retries, fake human acknowledgements and grants denied');
  console.log('D15C-5J OFFLINE PRODUCTION TRUST-BOUNDARY REVIEW PASSED');
  console.log('PUBLIC LAUNCH: NO_GO | proposed architecture only; no IAM, SQL or external custody');
} catch {
  console.error('REFUSE_D15C5J_REVIEW: unverified or inconsistent architecture evidence');
  process.exitCode=1;
}
