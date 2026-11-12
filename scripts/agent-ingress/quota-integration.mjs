/**
 * Phase D10 test: real restricted PostgreSQL quota on disposable Unix socket.
 * No DATABASE_URL use, no external network requests, no raw customer data.
 */
import pg from 'pg';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
const { Pool } = pg;
const SOCKET = process.env.PULSE_AGENT_SOCKET;
const DATA = process.env.PULSE_AGENT_DATA;
function guard() {
  assert.equal(process.env.PULSE_AGENT_DISPOSABLE_ONLY, 'YES');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.match(SOCKET ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(DATA, `${dirname(SOCKET)}/data`);
  const marker = `${dirname(SOCKET)}/.pulse-agent-enrollment-marker`;
  assert.ok(existsSync(marker) && lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink());
}
async function main() {
  guard();
  const pool = new Pool({ host: SOCKET, port: 55432, database: 'pulse_metrics',
    user: 'pulse_metrics_app', ssl: false, max: 12, connectionTimeoutMillis: 2500,
    statement_timeout: 8000, application_name:'pulse-agent-ingress-synthetic' });
  try {
    const identity = (await pool.query(`SELECT current_database() AS db,current_user AS role,
      inet_server_addr() IS NULL AS socket_only`)).rows[0];
    assert.deepEqual(identity, { db: 'pulse_metrics', role: 'pulse_metrics_app', socket_only: true });
    await assert.rejects(pool.query('SELECT * FROM pulse_agent_enrollment.ingress_rate_limits'),
      e => e.code === '42501');
    await assert.rejects(pool.query("SELECT * FROM pulse_agent_enrollment.consume_ingress_quota('redeem','actor',repeat('a',64))"),
      e => e.code === '22023');
    const check = async (action,kind,digest) => {
      const {rows} = await pool.query(`SELECT allowed,retry_after_seconds
        FROM pulse_agent_enrollment.consume_ingress_quota($1,$2,$3)`,[action,kind,digest]);
      assert.equal(rows.length,1);return rows[0];
    };
    const issueActor='a'.repeat(64);
    for(let n=1;n<=9;n++) {
      const v=await check('issue','actor',issueActor);
      assert.equal(v.allowed,n<=8); assert.equal(v.retry_after_seconds===0,n<=8);
    }
    console.log('PASS: actor issuance quota enforces 8/15-minute persistent limit');
    const issueNetwork='b'.repeat(64);
    for(let n=1;n<=41;n++) assert.equal((await check('issue','network',issueNetwork)).allowed,n<=40);
    const redeemNetwork='c'.repeat(64);
    for(let n=1;n<=26;n++) assert.equal((await check('redeem','network',redeemNetwork)).allowed,n<=25);
    console.log('PASS: independent issue/redeem network quotas enforce 40/25 limits');
    // Concurrent UPSERT across many restricted sessions MUST not exceed 25.
    const concurrent=await Promise.all(Array.from({length:35},()=>check('redeem','network','d'.repeat(64))));
    assert.equal(concurrent.filter(v=>v.allowed).length,25);
    assert.equal(concurrent.filter(v=>!v.allowed).length,10);
    console.log('PASS: 35 parallel callers admitted exactly 25, rejected 10');
    assert.equal((await check('issue','actor','e'.repeat(64))).allowed,true);
    console.log('PASS: quota buckets are independent and untrusted runtime cannot read counters');
  } finally {await pool.end();}
}
main().catch(e=>{console.error('D10 isolated quota rehearsal failed:',e?.message ?? 'unknown');process.exitCode=1;});
