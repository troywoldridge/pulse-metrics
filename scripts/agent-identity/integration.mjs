/**
 * D13 REAL PostgreSQL integration; disposable Unix-only cluster ONLY.
 * Synthetic WorkOS fixture names; no external network or real customer data.
 */
import pg from 'pg';
const { Client } = pg;
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const SOCKET=process.env.PULSE_AGENT_SOCKET;
const DATA=process.env.PULSE_AGENT_DATA;
const ORG_A=process.env.PULSE_AGENT_ORG_A;
const ORG_B=process.env.PULSE_AGENT_ORG_B;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function insist(v,reason){if(!v)throw Error('REFUSE_D13_REHEARSAL: '+reason);}
function guard(){
  insist(process.env.PULSE_AGENT_DISPOSABLE_ONLY==='YES'&&process.env.NODE_ENV!=='production',
    'disposable-only mode required');
  insist(typeof SOCKET==='string'&&/^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/.test(SOCKET) &&
    DATA===`${dirname(SOCKET)}/data`, 'unexpected socket/data path');
  const marker=`${dirname(SOCKET)}/.pulse-agent-enrollment-marker`;
  insist(existsSync(marker)&&lstatSync(marker).isFile()&&!lstatSync(marker).isSymbolicLink(),'missing marker');
  insist(UUID.test(ORG_A??'')&&UUID.test(ORG_B??'')&&ORG_A!==ORG_B,'distinct tenant fixtures required');
}
function secret(){const raw=randomBytes(32).toString('base64url');const hash=createHash('sha256').update(raw).digest('hex');return {hash,prefix:hash.slice(0,12),raw};}
async function open(){
  const c=new Client({host:SOCKET,port:55432,user:'pulse_metrics_app',database:'pulse_metrics',
    ssl:false,password:undefined,connectionTimeoutMillis:3000,statement_timeout:8000});
  await c.connect();
  const i=await c.query(`SELECT current_user AS role,current_database() AS db,
    inet_server_addr() IS NULL AS local_only,inet_server_port() IS NULL AS no_tcp`);
  insist(i.rows[0]?.role==='pulse_metrics_app'&&i.rows[0]?.db==='pulse_metrics'&&
    i.rows[0]?.local_only&&i.rows[0]?.no_tcp,'unexpected DB transport/role');
  return c;
}
async function issue(c,actor,org,hash,label='Preauthorized Linux',host='d13-agent.invalid'){
  const r=await c.query(`SELECT enrollment_id,agent_id FROM pulse_agent_enrollment.issue_preallocated_enrollment(
    $1::text,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz,$7::text,$8::text,$9::text,$10::text)`,
  [actor,org,hash.hash,hash.prefix,label,new Date(Date.now()+600000).toISOString(),
    'D13 Linux Agent',host,'linux','x86_64']);
  insist(r.rowCount===1&&UUID.test(r.rows[0].enrollment_id)&&UUID.test(r.rows[0].agent_id),
    'preauthorization did not return both IDs');
  return r.rows[0];
}
async function redeem(c,hash,credential,host='d13-agent.invalid'){
  return c.query(`SELECT organization_id,agent_id FROM pulse_agent_enrollment.redeem_preallocated_enrollment(
    $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text)`,
  [hash.hash,credential.hash,credential.prefix,'D13 Linux Agent',host,'linux','x86_64']);
}
async function failState(work,code,label){
  try {await work();}catch(e){insist(e.code===code,`${label}: wrong SQLSTATE ${String(e.code)}`);return;}
  insist(false,`${label}: request was not denied`);
}
async function main(){
  guard();let a,b,c;
  try {
    a=await open();
    const state=await a.query(`SELECT has_function_privilege(current_user,
      'pulse_agent_enrollment.issue_enrollment(text,uuid,text,text,text,timestamptz)','EXECUTE') AS old_issue,
      has_function_privilege(current_user,
      'pulse_agent_enrollment.redeem_enrollment(text,text,text,text,text,text,text)','EXECUTE') AS old_redeem,
      has_table_privilege(current_user,'pulse_agent_enrollment.preallocated_agent_bindings','SELECT') AS can_select`);
    insist(state.rows[0]?.old_issue===false&&state.rows[0]?.old_redeem===false&&
      state.rows[0]?.can_select===false,'old unbound operations or binding table exposed');
    await failState(()=>a.query('SELECT * FROM pulse_agent_enrollment.preallocated_agent_bindings'),
      '42501','direct binding table read');
    console.log('PASS: old unbound functions retired; app cannot read tenant bindings');

    await failState(()=>issue(a,'user_agent_viewer_a',ORG_A,secret()),'42501','viewer actor');
    await failState(()=>issue(a,'user_agent_owner_b',ORG_A,secret()),'42501','foreign owner');
    await failState(()=>issue(a,'user_agent_missing',ORG_A,secret()),'42501','missing actor');
    const token=secret();
    const pre=await issue(a,'user_agent_owner_a',ORG_A,token);
    console.log('PASS: verified owner preallocates pending agent and one-time token in the correct tenant');

    const newCred=secret();
    await failState(()=>redeem(a,secret(),newCred),'P0002','unknown token');
    await failState(()=>redeem(a,token,newCred,'attacker.invalid'),'P0002','metadata mismatch');
    const res=await redeem(a,token,newCred);
    insist(res.rowCount===1&&res.rows[0].organization_id===ORG_A&&
      res.rows[0].agent_id===pre.agent_id,'redeem did not use preallocated tenant agent');
    await failState(()=>redeem(a,token,secret()),'P0002','single-use replay');
    const verified=await a.query(`SELECT organization_id,agent_id
      FROM pulse_agent_enrollment.verify_credential($1::text)`,[newCred.hash]);
    insist(verified.rowCount===1&&verified.rows[0].agent_id===pre.agent_id&&
      verified.rows[0].organization_id===ORG_A,'bound credential not verified');
    console.log('PASS: wrong machine details refused without consumption; redemption binds EXACT preallocated agent');

    const raceToken=secret();const race=await issue(a,'user_agent_owner_a',ORG_A,raceToken);
    b=await open();c=await open();
    const first=secret(),second=secret();
    const results=await Promise.allSettled([redeem(b,raceToken,first),redeem(c,raceToken,second)]);
    const winners=results.filter(x=>x.status==='fulfilled');
    const losers=results.filter(x=>x.status==='rejected');
    insist(winners.length===1&&losers.length===1&&losers[0].reason?.code==='P0002'&&
      winners[0].value.rows[0].agent_id===race.agent_id&&
      winners[0].value.rows[0].organization_id===ORG_A,
      'concurrent redemption did not serialize once');
    let active=0;
    for(const cred of [first,second]){
      const r=await a.query('SELECT * FROM pulse_agent_enrollment.verify_credential($1::text)',[cred.hash]);
      active+=r.rowCount;
    }
    insist(active===1,'multiple active credentials for single preallocation');
    console.log('PASS: two independent PostgreSQL connections raced; exactly one credential issued');

    const otherToken=secret();const other=await issue(a,'user_agent_owner_b',ORG_B,otherToken,
      'Tenant B','b-server.invalid');
    const otherCred=secret();const otherResult=await redeem(a,otherToken,otherCred,'b-server.invalid');
    insist(otherResult.rows[0].organization_id===ORG_B&&otherResult.rows[0].agent_id===other.agent_id&&
      other.agent_id!==pre.agent_id,'foreign tenant binding crossed');
    await failState(()=>a.query(`SELECT pulse_agent_enrollment.revoke_agent(
      $1::text,$2::uuid,$3::uuid)`,['user_agent_owner_b',ORG_A,pre.agent_id]),'42501','cross tenant revoke');
    const revoked=await a.query(`SELECT pulse_agent_enrollment.revoke_agent(
      $1::text,$2::uuid,$3::uuid) AS revoked`,['user_agent_owner_a',ORG_A,pre.agent_id]);
    insist(revoked.rows[0]?.revoked===true,'authorized revoke failed');
    insist((await a.query('SELECT * FROM pulse_agent_enrollment.verify_credential($1::text)',
      [newCred.hash])).rowCount===0,'revoked credential still authenticates');
    console.log('PASS: separate organizations remain isolated; revocation invalidates bound machine credentials');
    console.log('========== D13 REAL PREAUTHORIZED AGENT IDENTITY REHEARSAL PASSED ==========');
  } finally {for(const cl of [c,b,a])if(cl)await cl.end();}
}
main().catch(e=>{console.error('REFUSE_D13_REHEARSAL: integration failed'+
  (typeof e?.code==='string'?' SQLSTATE='+e.code:''));process.exitCode=1;});
