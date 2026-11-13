/**
 * D15C-4B: test real restricted-role SQL in a marked disposable cluster only.
 * Synthetic customers, agents and secret hashes. No network listener.
 * This is intentionally not a production enrollment or ingestion client.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const SOCKET = process.env.PULSE_D15C4_SOCKET;
const DATA = process.env.PULSE_D15C4_DATA;
const ORG_A = process.env.PULSE_D15C4_ORG_A;
const ORG_B = process.env.PULSE_D15C4_ORG_B;
let stage = 'startup';

function guard() {
  assert.equal(process.env.PULSE_D15C4_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.match(SOCKET ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(DATA, `${dirname(SOCKET)}/data`);
  const marker = `${dirname(SOCKET)}/.pulse-telemetry-agent-quota-marker`;
  assert.ok(existsSync(marker) && lstatSync(marker).isFile() &&
    !lstatSync(marker).isSymbolicLink());
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(ORG_A ?? '', uuid);
  assert.match(ORG_B ?? '', uuid);
  assert.notEqual(ORG_A, ORG_B);
}

const makeSecret = () => {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { hash, prefix: hash.slice(0, 12) };
};

const sample = (value = 42, id = randomUUID()) => {
  const recordedAt = new Date().toISOString();
  const metrics = {
    'cpu.usage_percent': {
      metric: 'cpu.usage_percent', value, unit: 'percent',
      status: 'measured', observedAt: recordedAt,
    },
  };
  return {
    id, recordedAt, cpu: value, metrics,
    fingerprint: createHash('sha256').update(JSON.stringify(metrics)).digest('hex'),
  };
};

async function issueAndRedeem(pool, subject, organizationId, suffix) {
  const token = makeSecret();
  const credential = makeSecret();
  const issued = await pool.query(`
    SELECT pulse_agent_enrollment.issue_enrollment(
      $1::text,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz
    ) AS enrollment_id
  `, [subject,organizationId,token.hash,token.prefix,
      `D15C4 synthetic ${suffix}`,new Date(Date.now()+600000).toISOString()]);
  assert.equal(issued.rows.length,1);
  const redeemed = await pool.query(`
    SELECT * FROM pulse_agent_enrollment.redeem_enrollment(
      $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text
    )
  `, [token.hash,credential.hash,credential.prefix,
      `D15C4 synthetic Linux ${suffix}`,`d15c4-${suffix}.invalid`,'linux','x86_64']);
  assert.equal(redeemed.rows.length,1);
  assert.equal(redeemed.rows[0].organization_id,organizationId);
  return { credential,agentId:redeemed.rows[0].agent_id };
}

async function ingest(pool, credential, item) {
  const result = await pool.query(`
    SELECT pulse_telemetry_ingestion.ingest_submission(
      $1::text,$2::uuid,$3::text,$4::timestamptz,$5::integer,
      $6::real,$7::real,$8::real,$9::bigint,$10::bigint,$11::jsonb
    ) AS outcome
  `, [credential.hash,item.id,item.fingerprint,item.recordedAt,1,
       item.cpu,null,null,null,null,JSON.stringify(item.metrics)]);
  assert.equal(result.rows.length,1);
  return result.rows[0].outcome;
}

async function denied(action, sqlstate) {
  await assert.rejects(action, error => error?.code === sqlstate);
}

async function main() {
  guard();
  const pool = new Pool({ host:SOCKET,port:55432, database:'pulse_metrics',
    user:'pulse_metrics_app', ssl:false,max:16, connectionTimeoutMillis:2500,
    statement_timeout:15000, application_name:'pulse-d15c4-synthetic' });
  try {
    stage='validate restricted socket identity';
    const who = (await pool.query(`
      SELECT current_database() AS db,current_user AS role,
        inet_server_addr() IS NULL AS socket_only
    `)).rows[0];
    assert.deepEqual(who,{db:'pulse_metrics',role:'pulse_metrics_app',socket_only:true});

    stage='protected agent quota permissions';
    await denied(() => pool.query('SELECT * FROM pulse_telemetry_agent_quota.agent_buckets'),'42501');
    await denied(() => pool.query(`SELECT * FROM pulse_telemetry_agent_quota.consume_new_submission($1::uuid,$2::uuid)`,
      [randomUUID(),randomUUID()]),'42501');
    await denied(() => pool.query('SET ROLE pulse_metrics_telemetry_agent_quota_executor'),'42501');
    console.log('PASS: ordinary runtime denied private counters, direct function, owner role');

    stage='issue synthetic agents';
    const a1 = await issueAndRedeem(pool,'user_agent_owner_a',ORG_A,'a1');
    const a2 = await issueAndRedeem(pool,'user_agent_owner_a',ORG_A,'a2');
    const b1 = await issueAndRedeem(pool,'user_agent_owner_b',ORG_B,'b1');

    stage='exact duplicate and conflict accounting';
    const first=sample(42);
    assert.equal(await ingest(pool,a2.credential,first),'inserted');
    for(let n=0;n<5;n++) assert.equal(await ingest(pool,a2.credential,first),'duplicate');
    const changed=sample(43,first.id);
    assert.equal(await ingest(pool,a2.credential,changed),'conflict');
    console.log('PASS: repeated exact retries remain duplicate; altered same ID is conflict');

    stage='invalid agent secrets and invalid measurements';
    await denied(() => ingest(pool,makeSecret(),sample()),'42501');
    const bad=sample();
    bad.metrics['cpu.usage_percent'].status = 'unavailable';
    await denied(() => ingest(pool,a2.credential,bad),'22023');
    console.log('PASS: invalid credential and malformed telemetry denied');

    stage='concurrent agent quota';
    const attempts=135;
    const records=Array.from({length:attempts},(_,i)=>sample((i%75)+10));
    const results=await Promise.all(records.map(record=>ingest(pool,a1.credential,record)));
    const accepted=results.filter(value=>value==='inserted').length;
    const blocked=results.filter(value=>/^rate_limited:(?:[1-9]|[1-5][0-9]|60)$/.test(value)).length;
    assert.equal(accepted,120);
    assert.equal(blocked,15);
    assert.equal(results.length,accepted+blocked);
    console.log('PASS: 135 concurrent authenticated submissions: exactly 120 inserted, 15 rate limited');

    stage='duplicate when agent quota exhausted';
    const successIndex=results.findIndex(value=>value==='inserted');
    assert.ok(successIndex>=0);
    for(let n=0;n<3;n++)
      assert.equal(await ingest(pool,a1.credential,records[successIndex]),'duplicate');
    const fresh=await ingest(pool,a1.credential,sample());
    assert.match(fresh,/^rate_limited:(?:[1-9]|[1-5][0-9]|60)$/);
    console.log('PASS: exact duplicate after quota exhaustion succeeds; new sample denied');

    stage='tenant and agent isolation';
    assert.equal(await ingest(pool,b1.credential,first),'inserted');
    const distinct=sample(56);
    assert.equal(await ingest(pool,b1.credential,distinct),'inserted');
    assert.equal(await ingest(pool,a2.credential,distinct),'inserted');
    console.log('PASS: separate agents and organizations have independent quotas');

    stage='revocation before duplicate acknowledgment';
    const revoked=(await pool.query(`
      SELECT pulse_agent_enrollment.revoke_agent(
         $1::text,$2::uuid,$3::uuid
      ) AS revoked
    `,['user_agent_owner_a',ORG_A,a2.agentId])).rows[0].revoked;
    assert.equal(revoked,true);
    await denied(() => ingest(pool,a2.credential,first),'42501');
    await denied(() => ingest(pool,a2.credential,sample()),'42501');
    console.log('PASS: revoked credential denied even for previously valid identical retry');

    console.log('D15C-4B RESTRICTED POSTGRESQL INTEGRATION PASSED');
  } finally { await pool.end(); }
}

main().catch(error => {
  console.error('REFUSE_D15C4_INTEGRATION: stage='+stage);
  console.error('ERROR CATEGORY:',typeof error?.code==='string' ? error.code : error?.name ?? 'unknown');
  if(error?.name==='AssertionError') console.error('ASSERTION:',error.message);
  process.exitCode=1;
});
