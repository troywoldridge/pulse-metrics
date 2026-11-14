import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHITECTURE_REVIEW, PROPOSED_BOUNDARIES, REQUIRED_RELEASE_GATES,
  reviewProposedBoundaries, inspectReleaseGateRegister, reviewRecoveryAction,
  guardArchitectureRehearsal,
} from './production-security-boundary.mjs';
import { readFileSync } from 'node:fs';
const clone = x => JSON.parse(JSON.stringify(x));
const original = JSON.parse(readFileSync(new URL('../../docs/security/D15C-5J-RELEASE-GATE-REGISTER.json', import.meta.url), 'utf8'));
const valid = () => clone(PROPOSED_BOUNDARIES);
const gateRegister = () => clone(original);
const guardEnv = () => ({ PULSE_D15C5J_REVIEW_ONLY: 'YES', NODE_ENV: 'test' });

// A passed design can NEVER be used as an operations admission token.
test('5J valid architecture still requires review and never grants access', () => {
  assert.deepEqual(reviewProposedBoundaries(valid()), {
    decision:'review_required', reason:'real_provider_identity_grants_custody_and_tests_not_proven',
    productionAuthorized:false, publicLaunch:'NO_GO',
  });
  assert.equal(ARCHITECTURE_REVIEW.productionAuthorized, false);
  assert.equal(ARCHITECTURE_REVIEW.publicLaunch, 'NO_GO');
});
test('5J existing API role cannot become maintenance role', () => {
  const p = valid(); p.workloads.maintenance.databaseRole = 'pulse_metrics_app';
  assert.equal(reviewProposedBoundaries(p).decision, 'rejected');
});
test('5J migration, superuser, and unrestricted SQL roles all fail', () => {
  for (const role of ['pulse_metrics_migrator','postgres','PUBLIC','other_role']) {
    const p=valid(); p.workloads.maintenance.databaseRole=role;
    assert.equal(reviewProposedBoundaries(p).decision, 'rejected');
  }
});
test('5J direct deletes, RLS bypass or broad maintenance grants are rejected', () => {
  for (const privilege of ['DELETE','BYPASSRLS','ALL','tenant_read','unrestricted_exec']) {
    const p=valid(); p.workloads.maintenance.privileges=privilege;
    assert.equal(reviewProposedBoundaries(p).decision,'rejected');
  }
});
test('5J production schedule, alert delivery, or platform claim cannot self-activate', () => {
  for (const key of ['providerSelected','databaseGrantsApplied','scheduleEnabled',
      'networkDeliveryEnabled','productionDeploymentApproved']) {
    const p=valid(); p.activation[key]=true;
    assert.equal(reviewProposedBoundaries(p).decision, 'rejected');
  }
  const p=valid(); p.workloads.maintenance.enabled=true;
  assert.equal(reviewProposedBoundaries(p).decision, 'rejected');
});
test('5J custodial principal cannot collapse into maintenance identity', () => {
  const p=valid(); p.workloads.evidenceCustodian.principal=p.workloads.maintenance.principal;
  assert.equal(reviewProposedBoundaries(p).decision,'rejected');
});
test('5J private TLS hostname verification cannot be downgraded', () => {
  for (const mode of ['sslmode=require','plaintext','private_socket','public_internet']) {
    const p=valid(); p.workloads.maintenance.connection=mode;
    assert.equal(reviewProposedBoundaries(p).decision, 'rejected');
  }
});
test('5J local custody or caller-selected destinations not accepted as external trust', () => {
  for (const [place,key,value] of [
    ['evidenceCustodian','storage','local_jsonl'],
    ['evidenceCustodian','domain','same_cloud_role'],
    ['evidenceCustodian','keys','embedded_signer'],
    ['alertDispatcher','destination','https://attacker.invalid'],
  ]) {
    const p=valid(); p.workloads[place][key]=value;
    assert.equal(reviewProposedBoundaries(p).decision,'rejected');
  }
});
test('5J automated in-flight replay and queue rollbacks prohibited', () => {
  for (const state of ['automatic_retry','return_to_queued','clear_nonce']) {
    const p=valid();p.state.ambiguousInFlight=state;
    assert.equal(reviewProposedBoundaries(p).decision,'rejected');
  }
});
test('5J unexpected credentials, extra fields and unknown schema rejected', () => {
  for (const bad of [
    {...valid(), secret:'dont_echo_me'},
    {...valid(), schema:'v2'},
    {...valid(), workFlows:[]},
  ]) assert.equal(reviewProposedBoundaries(bad).decision, 'rejected');
});
test('5J prototype tricks and accessor objects are rejected', () => {
  const p=valid();
  Object.defineProperty(p.workloads, 'maintenance', {get(){throw Error('must never read');},enumerable:true});
  assert.equal(reviewProposedBoundaries(p).decision,'rejected');
  assert.equal(reviewProposedBoundaries(Object.assign(Object.create(null),valid())).decision,'rejected');
});
test('5J proposed identity is not real operator authentication', () => {
  const p=valid(); p.workloads.humanOperator.verified=true;
  assert.equal(reviewProposedBoundaries(p).decision,'rejected');
});
test('5J approved design has strictly separate workload roles and no live flags', () => {
  assert.equal(PROPOSED_BOUNDARIES.workloads.api.databaseRole,'pulse_metrics_app');
  assert.notEqual(PROPOSED_BOUNDARIES.workloads.api.principal,PROPOSED_BOUNDARIES.workloads.maintenance.principal);
  assert.notEqual(PROPOSED_BOUNDARIES.workloads.maintenance.principal,PROPOSED_BOUNDARIES.workloads.evidenceCustodian.principal);
  assert.equal(PROPOSED_BOUNDARIES.activation.productionDeploymentApproved,false);
});
test('5J release register lists 16 distinct unverified controls', () => {
  assert.equal(REQUIRED_RELEASE_GATES.length,16);
  assert.equal(new Set(REQUIRED_RELEASE_GATES).size,16);
  const result=inspectReleaseGateRegister(gateRegister());
  assert.deepEqual(result,{decision:'blocked',gateCount:16,externallyVerifiedGates:0,
    evidenceCollected:0,reason:'no_independently_verified_release_evidence',
    productionAuthorized:false, publicLaunch:'NO_GO'});
});
test('5J self-reported approved or passed gates are NEVER proof', () => {
  for (const status of ['approved','passed','verified',true,'waived','done']) {
    const r=gateRegister();r.gates[0].status=status;
    assert.equal(inspectReleaseGateRegister(r).decision,'rejected');
  }
});
test('5J claimed evidence and fake independent reviewer cannot self-authorize', () => {
  const r=gateRegister();r.gates[0].evidenceReference='s3://some-bucket/claim';
  assert.equal(inspectReleaseGateRegister(r).decision,'rejected');
  const r2=gateRegister();r2.gates[0].externalReviewer='self-approval';
  assert.equal(inspectReleaseGateRegister(r2).decision,'rejected');
});
test('5J missing, repeated and unknown gates fail closed', () => {
  const fewer=gateRegister();fewer.gates.pop();
  assert.equal(inspectReleaseGateRegister(fewer).decision,'rejected');
  const repeated=gateRegister();repeated.gates[0]=clone(repeated.gates[1]);
  assert.equal(inspectReleaseGateRegister(repeated).decision,'rejected');
  const wrong=gateRegister();wrong.gates[0].id='made_up_gate';
  assert.equal(inspectReleaseGateRegister(wrong).decision,'rejected');
});
test('5J invented fields, wrong launch status or schema rejected', () => {
  for (const changed of [
    {...gateRegister(), productionAuthorized:true},
    {...gateRegister(), launchStatus:'GO'},
    {...gateRegister(), schema:'v2'},
  ]) assert.equal(inspectReleaseGateRegister(changed).decision,'rejected');
  const r=gateRegister();r.gates[0].extra='ignore';
  assert.equal(inspectReleaseGateRegister(r).decision,'rejected');
});
test('5J release gate entries in alternate order are still verified as inventory', () => {
  const r=gateRegister();r.gates.reverse();
  assert.equal(inspectReleaseGateRegister(r).decision,'blocked');
});
test('5J null, array, string and prototype inputs are never a release gate', () => {
  for (const r of [null,[],true,'approved',Object.create(null)]) {
    assert.equal(inspectReleaseGateRegister(r).decision,'rejected');
  }
});
test('5J unknown and in-flight delivery NEVER auto-retry', () => {
  for (const state of ['unknown','in_flight']) {
    for (const action of ['automatic_retry','send_again','mark_human_acknowledged']) {
      assert.equal(reviewRecoveryAction({sourceState:state,action}).decision,'denied');
    }
    assert.equal(reviewRecoveryAction({sourceState:state,action:'request_manual_reconciliation'}).reason,
      'delivery_outcome_ambiguous');
  }
});
test('5J even queued or accepted receipt cannot force a send or ack', () => {
  for (const sourceState of ['queued','transport_accepted','receiver_duplicate','dead_letter']) {
    for (const action of ['send_again','mark_human_acknowledged','approve_production','grant_database_role']) {
      const result=reviewRecoveryAction({sourceState,action});
      assert.equal(result.decision,'denied');assert.equal(result.performed,false);
    }
  }
});
test('5J inspection only requests human review and performs nothing', () => {
  for (const sourceState of ['queued','in_flight','transport_accepted','receiver_duplicate','dead_letter','unknown']) {
    const decision=reviewRecoveryAction({sourceState, action:'inspect'});
    assert.equal(decision.decision,'manual_review_required');
    assert.equal(decision.performed,false);
    assert.equal(decision.productionAuthorized,false);
  }
});
test('5J invalid actions and forged identity fields are rejected', () => {
  for (const candidate of [
    {sourceState:'queued',action:'run_shell'},
    {sourceState:'queued',action:'inspect',operator:'admin'},
    {sourceState:'delivered',action:'inspect'},
    null,[], 'safely retry',
  ]) assert.equal(reviewRecoveryAction(candidate).decision,'rejected');
});
test('5J unsafe rehearsal environment fails before checking any resources', () => {
  for (const [name,value] of [
    ['DATABASE_URL','test'],['PGPASSWORD','test'],['PGHOST','localhost'],
    ['MIGRATION_DATABASE_URL','test'],['ALERT_DESTINATION_URL','https://example.invalid'],
    ['PULSE_D15C5J_DEPLOY','YES'],['PULSE_D15C5J_OPERATOR_TOKEN','SECRET'],
    ['PULSE_D15C5J_CUSTODY_URL','https://example.invalid'],
  ]) assert.throws(()=>guardArchitectureRehearsal({...guardEnv(),[name]:value},2),/denied/);
});
test('5J production, missing approval, extra argv and malformed env fail closed', () => {
  for (const [env,argc] of [
    [{...guardEnv(),NODE_ENV:'production'},2],
    [{NODE_ENV:'test'},2],
    [guardEnv(),3],
    [null,2],
    [[],2],
  ]) assert.throws(()=>guardArchitectureRehearsal(env,argc),/denied/);
});
test('5J safe offline guard can only return a review flag, never an execution token', () => {
  assert.deepEqual(guardArchitectureRehearsal(guardEnv(),2),
    {reviewOnly:true,productionAuthorized:false});
  assert.equal(ARCHITECTURE_REVIEW.realOperatorVerified,false);
  assert.equal(ARCHITECTURE_REVIEW.grantsApplied,false);
  assert.equal(ARCHITECTURE_REVIEW.externalCustodyVerified,false);
});
