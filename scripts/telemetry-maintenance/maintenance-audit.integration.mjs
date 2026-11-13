/**
 * D15C-5D review-only integration: real disposable PostgreSQL + 5C controller
 * + local audit journal + alert candidate records. NEVER connects via URL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { verifyAuditJournal, AUDIT_POLICY } from './maintenance-audit-policy.mjs';
import { assertRehearsalJournalPhase } from './maintenance-audit-rehearsal-phase.mjs';
import { MAINTENANCE_POLICY } from './controlled-maintenance-policy.mjs';

const { Client } = pg;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = resolve(ROOT, 'scripts/telemetry-maintenance/maintenance-audit-cli.mjs');
const SOCKET = process.env.PULSE_D15C5D_SOCKET;
const DATA = process.env.PULSE_D15C5D_DATA;
const DIR = process.env.PULSE_D15C5D_AUDIT_DIR;
let stage = 'guard';
function guard() {
  assert.equal(process.env.PULSE_D15C5D_DISPOSABLE_ONLY,'YES');
  assert.notEqual(process.env.NODE_ENV,'production');
  assert.match(SOCKET ?? '', /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/);
  assert.equal(DATA,`${dirname(SOCKET)}/data`);
  assert.match(DIR ?? '', AUDIT_POLICY.directoryPattern);
  for(const name of ['.pulse-telemetry-quota-marker','.pulse-telemetry-agent-quota-marker']) {
    const file=`${dirname(SOCKET)}/${name}`;
    assert.ok(existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
  }
  // First pass requires empty journal; revoked-permission pass requires the
  // four authenticated receipts already created in the initial pass.
  // Verify the COMPLETE hash chain in either phase before proceeding.
  assertRehearsalJournalPhase(
    verifyAuditJournal(DIR), process.env.PULSE_D15C5D_EXPECT_REVOKED);
}
function connect(user) {
  return new Client({host:SOCKET,port:55432,user,database:'pulse_metrics',ssl:false,
    connectionTimeoutMillis:2500,statement_timeout:3500,query_timeout:4500,
    application_name:'pulse-d15c5d-disposable-audit-integration'});
}
const key = label => createHash('sha256').update('pulse-d15c5d-'+label).digest('hex');
function invoke(overrides={}) {
  const call=spawnSync(process.execPath,[CLI],{
    cwd:ROOT,encoding:'utf8',timeout:15000,maxBuffer:16384,
    env:{ ...process.env,
      PULSE_D15C5D_DISPOSABLE_ONLY:'YES',
      PULSE_D15C5D_SOCKET:SOCKET,
      PULSE_D15C5D_DATA:DATA,
      PULSE_D15C5D_AUDIT_DIR:DIR,
      ...overrides,
    },
  });
  assert.equal(call.signal,null,'audit CLI timed out');
  assert.equal(call.error,undefined,'audit CLI spawn error');
  assert.equal(call.stderr,'','audit CLI leaked stderr');
  assert.ok(typeof call.stdout==='string' && call.stdout.length < 3000);
  assert.equal(call.stdout.includes(DATA),false,'data path disclosed');
  assert.equal(call.stdout.includes('password'),false,'secret disclosed');
  assert.equal(call.stdout.includes('SELECT '),false,'SQL disclosed');
  const lines=call.stdout.trim().split('\n');
  const entries=lines.map(line=>{
    const m=/^D15C5D_(EVENT|ALERT) (\{.*\})$/.exec(line);
    assert.ok(m,'unexpected audit stdout');
    return {type:m[1], value:JSON.parse(m[2])};
  });
  return {code:call.status,entries};
}
function recorded(result,status,sequence,code=null) {
  assert.equal(result.code, status==='failed'||status==='invalid_output'?1:0);
  const entries=result.entries;
  assert.equal(entries.length,code===null?1:2);
  assert.equal(entries[0].type,'EVENT');
  assert.deepEqual(entries[0].value.event,'audit_recorded');
  assert.equal(entries[0].value.sequence,sequence);
  assert.equal(entries[0].value.status,status);
  if(code!==null) {
    assert.equal(entries[1].type,'ALERT');
    assert.deepEqual(entries[1].value,{event:'alert_candidate',sequence,
      code,severity:code==='maintenance_possible_backlog'?'warning':'critical'});
  }
}
async function counts(fixture) {
  const r=await fixture.query(`
    SELECT
    (SELECT count(bucket_digest)::integer FROM pulse_telemetry_quota.network_buckets
      WHERE window_end < clock_timestamp() - interval '48 hours') AS network,
    (SELECT count(agent_id)::integer FROM pulse_telemetry_agent_quota.agent_buckets
      WHERE window_end < clock_timestamp() - interval '48 hours') AS agent
  `);
  return r.rows[0];
}
async function main() {
  guard();
  if (process.env.PULSE_D15C5D_EXPECT_REVOKED === 'YES') {
    stage = 'revoked maintenance function produces durable failure alert';
    const existing = verifyAuditJournal(DIR);
    assert.equal(existing.sequence,4);
    const failure = invoke();
    recorded(failure,'failed',5,'maintenance_operation_failed');
    const checked = verifyAuditJournal(DIR);
    assert.equal(checked.sequence,5);
    assert.equal(checked.rows[4].previousHash, checked.rows[3].hash);
    assert.equal(checked.rows[4].alertCode,'maintenance_operation_failed');
    assert.equal(checked.rows[4].severity,'critical');
    assert.equal(checked.rows[4].status,'failed');
    assert.equal(checked.rows[4].networkRemoved,0);
    assert.equal(checked.rows[4].agentRemoved,0);
    console.log('PASS: real revoked function emits critical alert candidate and durable sanitized failure receipt');
    return;
  }
  const fixture=connect('pulse_metrics_test_fixture');
  const maint=connect('pulse_metrics_test_maintainer');
  await fixture.connect();
  await maint.connect();
  try {
    stage='check disposable database identities';
    const id=await maint.query(`
      SELECT current_database() AS db,current_user AS role,
      inet_server_addr() IS NULL AS local_only,
      current_setting('listen_addresses') = '' AS tcp_disabled
    `);
    assert.deepEqual(id.rows[0],{db:'pulse_metrics',role:'pulse_metrics_test_maintainer',
      local_only:true,tcp_disabled:true});
    assert.deepEqual(await counts(fixture),{network:0,agent:0});

    stage='config denial before database access';
    for(const overrides of [
      {PULSE_D15C5D_DISPOSABLE_ONLY:''},
      {NODE_ENV:'production'},
      {DATABASE_URL:'postgres://dont-use.invalid/never'},
    ]) {
      const denied=invoke(overrides);
      assert.equal(denied.code,1);
      assert.deepEqual(denied.entries,[{type:'EVENT',value:{event:'audit_configuration_denied',alert:true}}]);
      assert.equal(verifyAuditJournal(DIR).sequence,0);
    }
    console.log('PASS: D15C-5D unsafe configuration rejected before maintenance');

    stage='no-work event persists without alarm';
    const nothing=invoke();
    recorded(nothing,'completed',1);
    assert.equal(nothing.entries[0].value.batches,1);
    assert.equal(nothing.entries[0].value.networkRemoved,0);
    console.log('PASS: audit journal recorded completed no-work run without alarm');

    stage='synthetic expired records';
    await fixture.query(`
      INSERT INTO pulse_telemetry_quota.network_buckets
        (bucket_digest, attempts, window_end)
      SELECT md5('d15c5d-net-a-' || g::text) || md5('d15c5d-net-b-' || g::text),
        3, clock_timestamp() - interval '4 days'
      FROM generate_series(1,770) AS g
    `);
    await fixture.query(`
      INSERT INTO pulse_telemetry_agent_quota.agent_buckets
        (organization_id, agent_id, attempts, window_end)
      SELECT gen_random_uuid(),gen_random_uuid(),3,clock_timestamp()-interval '4 days'
      FROM generate_series(1,770) AS g
    `);
    // Active and recent rows should survive both runs.
    const freshKey=key('active');
    await fixture.query(`
      INSERT INTO pulse_telemetry_quota.network_buckets
        (bucket_digest,attempts,window_end)
      VALUES ($1::text,3,clock_timestamp()+interval '60 seconds')
    `,[freshKey]);
    const currentAgent=await fixture.query(`
      INSERT INTO pulse_telemetry_agent_quota.agent_buckets
        (organization_id,agent_id,attempts,window_end)
      VALUES (gen_random_uuid(),gen_random_uuid(),3,clock_timestamp()-interval '1 hour')
      RETURNING organization_id,agent_id
    `);
    assert.equal(currentAgent.rowCount,1);
    assert.deepEqual(await counts(fixture),{network:770,agent:770});

    stage='bounded cleanup and backlog warning';
    const backlog=invoke();
    recorded(backlog,'completed',2,'maintenance_possible_backlog');
    assert.deepEqual(backlog.entries[0].value,{event:'audit_recorded',sequence:2,
      status:'completed',batches:3,networkRemoved:750,agentRemoved:750,alert:true});
    assert.deepEqual(await counts(fixture),{network:20,agent:20});
    console.log('PASS: 750+750 bounded cleanup recorded; local backlog warning emitted');

    stage='remaining cleanup and no alarm';
    const drained=invoke();
    recorded(drained,'completed',3);
    assert.deepEqual(await counts(fixture),{network:0,agent:0});
    const preserved=await fixture.query(`
      SELECT
       (SELECT count(bucket_digest)::integer FROM pulse_telemetry_quota.network_buckets
         WHERE bucket_digest=$1::text) AS active_network,
       (SELECT count(agent_id)::integer FROM pulse_telemetry_agent_quota.agent_buckets
         WHERE organization_id=$2::uuid AND agent_id=$3::uuid) AS recent_agent
    `,[freshKey,currentAgent.rows[0].organization_id,currentAgent.rows[0].agent_id]);
    assert.deepEqual(preserved.rows[0],{active_network:1,recent_agent:1});
    console.log('PASS: drained residual quota without deleting active/recent records');

    stage='real independent advisory-lock overlap';
    await maint.query('SELECT pg_advisory_lock($1::integer,$2::integer)',
      [MAINTENANCE_POLICY.lockKeyA,MAINTENANCE_POLICY.lockKeyB]);
    try {
      const overlapped=invoke();
      recorded(overlapped,'overlap_skipped',4);
    } finally {
      const release=await maint.query('SELECT pg_advisory_unlock($1::integer,$2::integer) AS released',
        [MAINTENANCE_POLICY.lockKeyA,MAINTENANCE_POLICY.lockKeyB]);
      assert.equal(release.rows[0].released,true);
    }
    console.log('PASS: overlapping controller produces audit receipt, not false alarm');

    stage='revoke test-only maintenance permission';
    // Fixture cannot revoke; only shell wrapper's postgres SQL may do so.
    // Request that SQL through a narrowly approved read-only handoff:
    // this integration deliberately invokes a callback via psql in the
    // disposable launcher before re-running the audit wrapper.
    const deniedViaGuard=invoke({PGPASSWORD:'SHOULD_NOT_BE_VISIBLE'});
    assert.equal(deniedViaGuard.code,1);
    assert.equal(verifyAuditJournal(DIR).sequence,4);
    console.log('PASS: libpq password override denied without new journal record');

    stage='check previous hash chain and sanitized alerts';
    const chain=verifyAuditJournal(DIR);
    assert.equal(chain.sequence,4);
    assert.deepEqual(chain.rows.map(r=>r.alertCode),
      [null,'maintenance_possible_backlog',null,null]);
    assert.deepEqual(chain.rows.map(r=>r.status),
      ['completed','completed','completed','overlap_skipped']);
    assert.equal(chain.rows[3].previousHash,chain.rows[2].hash);
    const raw=readFileSync(`${DIR}/${AUDIT_POLICY.file}`,'utf8');
    assert.equal(raw.includes(SOCKET),false);
    assert.equal(raw.includes('postgres'),false);
    assert.equal(raw.includes('password'),false);
    console.log('PASS: private SHA-256 audit chain, counters and alert classifications verified');

    stage='tamper rejection before controller connection';
    const journal=`${DIR}/${AUDIT_POLICY.file}`;
    const saved=readFileSync(journal,'utf8');
    writeFileSync(journal,saved.replace('overlap_skipped','maintenance_failed'));
    const bad=invoke();
    assert.equal(bad.code,1);
    assert.deepEqual(bad.entries,[{type:'EVENT',value:{event:'audit_configuration_denied',alert:true}}]);
    writeFileSync(journal,saved);
    assert.equal(verifyAuditJournal(DIR).sequence,4);
    console.log('PASS: journal tampering blocks maintenance before DB access');
    console.log('D15C-5D DISPOSABLE AUDIT AND ALERT-CANDIDATE INTEGRATION PASSED');
  } finally {
    await maint.end().catch(()=>{});
    await fixture.end().catch(()=>{});
  }
}
main().catch(error=>{
  console.error(`REFUSE_D15C5D_INTEGRATION: stage=${stage}`);
  console.error(`ERROR CATEGORY: ${error?.code && /^\d{5}$/.test(error.code)?error.code:'CHECK_FAILED'}`);
  process.exitCode=1;
});
