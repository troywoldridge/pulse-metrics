import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { closeDatabase } from '../../src/db/client.js';
import {
  consumePersistedInvitationBucket,
} from '../../src/server/security/invitation-rate-limit.js';

/** Run ONLY through the guarded local script. All digests are synthetic and
 * unique to this one invocation; no real identifiers or tokens are used. */
const suffix=process.env.PULSE_LIMIT_FIXTURE;
if (!suffix || !/^[a-f0-9]{20}$/.test(suffix)) throw Error('Missing safe synthetic fixture suffix');
const hash = (kind: string) => createHash('sha256')
  .update(`pulse-rate-limit-test-v1:${suffix}:${kind}`, 'utf8').digest('hex');
const digest = {
  actorIssue: hash('actor-issue'),
  networkIssue: hash('network-issue'),
  actorAccept: hash('actor-accept'),
  networkAccept: hash('network-accept'),
  concurrent: hash('concurrent'),
  reset: hash('reset'),
  separate: hash('separate'),
};
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:14,connectionTimeoutMillis:5000});
const consume = async (action:string,kind:string,value:string) => {
  const result=await pool.query(
    'SELECT allowed,retry_after_seconds FROM public.consume_invitation_rate_limit($1,$2,$3)',
    [action,kind,value],
  );
  assert.equal(result.rowCount,1);
  const r=result.rows[0];
  assert.equal(typeof r.allowed,'boolean');
  assert.ok(Number.isInteger(r.retry_after_seconds));
  return {allowed:r.allowed as boolean,retryAfterSeconds:r.retry_after_seconds as number};
};
const denied = async (fn:Promise<unknown>,code:string) => assert.rejects(fn,(err:unknown)=>
  !!err && typeof err==='object' && (err as {code?:unknown}).code===code);

test('REAL PostgreSQL multi-instance invitation rate-limit security',async t=>{
  try {
    const role=await pool.query('SELECT current_user AS name');
    assert.equal(role.rows[0]?.name,'pulse_metrics_app');

    await t.test('actor issuance permits ten attempts then 429-equivalent denial', async()=>{
      for(let i=0;i<10;i++) assert.equal((await consume('issue','actor',digest.actorIssue)).allowed,true);
      for(let i=0;i<3;i++){
        const r=await consume('issue','actor',digest.actorIssue);
        assert.equal(r.allowed,false);
        assert.ok(r.retryAfterSeconds>=1 && r.retryAfterSeconds<=900);
      }
    });

    await t.test('independent action and bucket kind do not share quotas',async()=>{
      assert.equal((await consume('accept','actor',digest.actorIssue)).allowed,true);
      assert.equal((await consume('issue','network',digest.actorIssue)).allowed,true);
      assert.equal((await consume('issue','actor',digest.separate)).allowed,true);
    });

    await t.test('network issuance permits sixty attempts then denies',async()=>{
      for(let i=0;i<60;i++) assert.equal((await consume('issue','network',digest.networkIssue)).allowed,true);
      assert.equal((await consume('issue','network',digest.networkIssue)).allowed,false);
    });

    await t.test('actor redemption permits twenty attempts then denies',async()=>{
      for(let i=0;i<20;i++) assert.equal((await consume('accept','actor',digest.actorAccept)).allowed,true);
      assert.equal((await consume('accept','actor',digest.actorAccept)).allowed,false);
    });

    await t.test('network redemption permits one hundred twenty attempts then denies',async()=>{
      for(let i=0;i<120;i++) assert.equal((await consume('accept','network',digest.networkAccept)).allowed,true);
      assert.equal((await consume('accept','network',digest.networkAccept)).allowed,false);
    });

    await t.test('multi-connection race allows precisely ten concurrent actor requests',async()=>{
      const results=await Promise.all(Array.from({length:25},()=>consume('issue','actor',digest.concurrent)));
      assert.equal(results.filter(x=>x.allowed).length,10);
      assert.equal(results.filter(x=>!x.allowed).length,15);
    });

    await t.test('invalid policy and malformed digest are rejected',async()=>{
      await denied(consume('reset-all','actor',digest.reset),'22023');
      await denied(consume('issue','all',digest.reset),'22023');
      await denied(consume('issue','actor','plain-ip-192.0.2.5'),'22023');
      await denied(consume('issue','actor','A'.repeat(64)),'22023');
    });

    await t.test('runtime cannot view, reset or delete persistent counters',async()=>{
      await denied(pool.query('SELECT * FROM public.invitation_rate_limits'),'42501');
      await denied(pool.query('DELETE FROM public.invitation_rate_limits'),'42501');
      await denied(pool.query('UPDATE public.invitation_rate_limits SET attempts=1'),'42501');
    });

    await t.test('real TypeScript adapter invokes restricted SQL function',async()=>{
      const r=await consumePersistedInvitationBucket('issue','actor',digest.reset);
      assert.deepEqual(r,{allowed:true,retryAfterSeconds:0});
    });

    console.log('PASS: restricted-role DB, fixed quotas, reset/race protections and API adapter');
  } finally {await pool.end();await closeDatabase();}
});
