import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXED_SHORTLIST, PLATFORM_REVIEW_INVARIANTS,
  inspectPlatformShortlist, inspectCostScenario, guardPlatformReview,
} from './platform-shortlist-contract.mjs';

const clone = () => JSON.parse(JSON.stringify(FIXED_SHORTLIST));
const deny = obj => assert.equal(inspectPlatformShortlist(obj).decision, 'rejected');

// No test is a real provider integration, account, billing or runtime identity test.
test('5K is unconditionally non-deploying and public launch stays blocked', () => {
  assert.deepEqual(Object.values(PLATFORM_REVIEW_INVARIANTS).filter(x => x === true), []);
  assert.equal(PLATFORM_REVIEW_INVARIANTS.launch, 'NO_GO');
});
test('5K fixed candidate requires external review, never self-approves', () => {
  const r = inspectPlatformShortlist(clone());
  assert.equal(r.decision, 'external_review_required');
  assert.equal(r.candidate, 'self_host_existing_server_pilot');
  assert.equal(r.candidateAccepted, false);
  assert.equal(r.productionAuthorized, false);
  assert.equal(r.releaseGatesVerified, 0);
});
test('5K base budget is component arithmetic, not an all-in quote', () => {
  for (const [id, amount] of [['do_basic_managed_pg',39], ['render_2g_managed_pg',44],['do_ha_database_scenario',84]]) {
    const r = inspectCostScenario(clone(), id);
    assert.equal(r.subtotalUsd, amount);
    assert.equal(r.allInQuote, false);
    assert.equal(r.productionAuthorized, false);
    assert.equal(r.excludedCostCategories, 10);
  }
});
test('5K unknown provider never gets priced or approved', () => {
  assert.equal(inspectCostScenario(clone(), 'aws_all_in').decision, 'rejected');
});
test('5K cannot mark proposed decision accepted', () => {
  const p=clone(); p.decisionStatus='accepted'; deny(p);
});
test('5K cannot claim customer launch or production authorization', () => {
  for (const [key, value] of [['publicLaunch','GO'],['productionAuthorized',true],['resourcesProvisioned',true]]) {
    const p=clone();p[key]=value;deny(p);
  }
});
test('5K source and date snapshots cannot be silently replaced', () => {
  for (const [key, value] of [['asOf','2027-01-01'], ['purpose','deployment_ready'], ['schema','v2']]) {
    const p=clone(); p[key]=value;deny(p);
  }
});
test('5K default managed PG lacks HA and cannot claim otherwise', () => {
  const p=clone();p.options[0].databaseAvailability='ha';deny(p);
});
test('5K Render internal TLS cannot pretend to verify hostname', () => {
  const p=clone();p.options[1].tlsMode='verify-full-required';deny(p);
});
test('5K cannot downgrade DO database certificate and hostname checks', () => {
  const p=clone();p.options[0].tlsMode='require';deny(p);
});
test('5K rejects a public database in place of same-VPC endpoint', () => {
  const p=clone();p.options[0].privateNetwork='public-internet';deny(p);
});
test('5K cannot replace independent custody with local storage', () => {
  const p=clone();p.options[0].custody='local-file';deny(p);
});
test('5K cannot collapse service and custody identity', () => {
  const p=clone();p.options[0].identity='shared-role';deny(p);
});
test('5K cannot silently revise quoted prices', () => {
  for (const [field,value] of [['appMonthlyUsd',7],['databaseMonthlyUsd',0],['baseMonthlyUsd',0]]) {
    const p=clone();p.options[0][field]=value;deny(p);
  }
});
test('5K cannot disguise a cheaper provider by changing its ID', () => {
  const p=clone();p.options[0].id='new_vendor';deny(p);
});
test('5K unpriced operational costs cannot be deleted', () => {
  const p=clone();p.unpricedItems.pop();deny(p);
});
test('5K unknown, duplicated or missing evidence requirements fail', () => {
  const p=clone();p.requiredExternalEvidence[0]=p.requiredExternalEvidence[1];deny(p);
  const q=clone();q.requiredExternalEvidence.push('fake-approved');deny(q);
});
test('5K 16 predecessor release gates cannot claim validation', () => {
  const p=clone();p.externallyVerifiedReleaseGates=16;deny(p);
  const q=clone();q.releaseGateCount=15;deny(q);
});
test('5K source URLs cannot be replaced by attacker URLs', () => {
  const p=clone();p.sources[0]='https://untrusted.invalid';deny(p);
});
test('5K unknown data fields or options cannot grant hidden privileges', () => {
  const p=clone();p.providerToken='secret';deny(p);
  const q=clone();q.options[0].approved=true;deny(q);
});
test('5K malformed data, arrays, custom prototypes are refused', () => {
  for (const x of [null, undefined, 'approved', [], new Date(), Object.create(null)]) deny(x);
});
test('5K prototype pollution and getters are refused without evaluation', () => {
  const p=clone();p.__proto__={isAdmin:true};deny(p);
  const q=clone();Object.defineProperty(q,'providerToken',{enumerable:true,get(){throw Error('getter executed');}});deny(q);
});
test('5K fixed option objects and evidence arrays cannot be mutated at runtime', () => {
  assert.equal(Object.isFrozen(FIXED_SHORTLIST.options), true);
  assert.equal(Object.isFrozen(FIXED_SHORTLIST.options[0]), true);
  assert.equal(Object.isFrozen(FIXED_SHORTLIST.requiredExternalEvidence), true);
});
test('5K array accessors are rejected without invoking the getter', () => {
  const p=clone();
  Object.defineProperty(p.options, '0', {enumerable:true, configurable:true, get(){throw Error('getter invoked');}});
  deny(p);
});
test('5K duplicate source and options fail rather than falling back', () => {
  const p=clone();p.options[1]=structuredClone(p.options[0]);deny(p);
});
test('5K budget comparison refuses forged proposal', () => {
  const p=clone();p.options[0].baseMonthlyUsd=1;
  assert.equal(inspectCostScenario(p, 'do_basic_managed_pg').decision, 'rejected');
});
test('5K explicit guard returns no live capability', () => {
  const r=guardPlatformReview({PULSE_D15C5K_REVIEW_ONLY:'YES',NODE_ENV:'test'},2);
  assert.equal(r.networkAllowed,false);
  assert.equal(r.providerSelected,false);
  assert.equal(r.productionAuthorized,false);
});
test('5K missing review approval, production or arguments are denied', () => {
  for (const [e,argc] of [[{},2],[{PULSE_D15C5K_REVIEW_ONLY:'YES',NODE_ENV:'production'},2],
    [{PULSE_D15C5K_REVIEW_ONLY:'YES'},3]]) {
    assert.throws(()=>guardPlatformReview(e,argc),/d15c5k_offline_guard_denied/);
  }
});
test('5K forbids live DB, cloud credentials, destinations, deployment and purchase', () => {
  for (const key of ['DATABASE_URL','PGPASSWORD','PGHOST','AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY','DIGITALOCEAN_ACCESS_TOKEN','RENDER_API_KEY',
    'S3_BUCKET','KMS_KEY_ID','ALERT_DESTINATION_URL','PULSE_D15C5K_DEPLOY',
    'PULSE_D15C5K_APPROVED','PULSE_D15C5K_PURCHASE']) {
    assert.throws(()=>guardPlatformReview({PULSE_D15C5K_REVIEW_ONLY:'YES',[key]:'synthetic'},2));
  }
});

// Existing hardware is NOT zero-cost, externally verified, or live-approved.
test('5K self-host pilot is a conditional preference, never accepted hosting', () => {
  const p=clone();
  assert.equal(p.proposedPilot, 'self_host_existing_server_pilot');
  assert.equal(inspectPlatformShortlist(p).candidateAccepted, false);
  assert.equal(p.serverInspection.publicLaunchApproved, false);
  assert.equal(p.serverInspection.evidenceClass, 'operator_read_only_terminal_observation');
});
test('5K existing server cost is unknown rather than zero', () => {
  const r=inspectCostScenario(clone(),'self_host_existing_server_pilot');
  assert.equal(r.decision, 'unquantified_existing_hardware');
  assert.equal(r.subtotalUsd, null);
  assert.equal(r.allInQuote, false);
  assert.equal(r.productionAuthorized, false);
  assert.equal(r.excludedCostCategories,10);
});
test('5K self-host candidate cannot claim failover or independent backup', () => {
  const p=clone();p.options[3].databaseAvailability='highly-available';deny(p);
  const q=clone();q.serverInspection.twoDisksAreIndependentOffsiteBackup=true;deny(q);
});
test('5K local SSH TCP check cannot be upgraded to PostgreSQL authentication', () => {
  const p=clone();p.serverInspection.postgresAuthenticationThroughTunnelVerified=true;deny(p);
});
test('5K private pilot cannot mark offsite custody, load test or public IP audit passed', () => {
  for (const key of ['offsiteRestoreDrillPassed','independentCustodyVerified',
    'loadTestPassed','publicIpReachabilityAudited','publicLaunchApproved']) {
    const p=clone();p.serverInspection[key]=true;deny(p);
  }
});
test('5K stale firewall source and all-interface listener cannot be hidden', () => {
  const p=clone();p.serverInspection.ufw5432LegacySourceRuleStillPresent=false;deny(p);
  const q=clone();q.serverInspection.postgresqlListenerOnAllInterfaces=false;deny(q);
});
test('5K candidate cannot claim nonexistent free all-in hosting quote', () => {
  const p=clone();p.options[3].baseMonthlyUsd=0;deny(p);
  const q=clone();q.options[3].appMonthlyUsd=0;deny(q);
  const r=clone();r.options[3].databaseMonthlyUsd=0;deny(r);
});
test('5K cannot swap candidate back to cloud without a new reviewed fingerprint', () => {
  const p=clone();p.proposedPilot='do_basic_managed_pg';deny(p);
});
test('5K private pilot cannot be auto-activated through environment', () => {
  assert.throws(()=>guardPlatformReview({PULSE_D15C5K_REVIEW_ONLY:'YES',
    PULSE_D15C5K_SELFHOST_DEPLOY:'YES'},2),/d15c5k_offline_guard_denied/);
});
