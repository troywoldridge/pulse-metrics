/**
 * Synthetic, loopback-only proxy HTTP ingress with REAL persisted quotas.
 * This does not prove real TLS or WorkOS verification. Not production-mounted.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import http from 'node:http';
import express from 'express';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPostgresAgentQuotaConsumer, createAgentQuotaLimiter } from '../../src/server/security/agent-enrollment-quota.js';
import { createAgentEnrollmentIngressGuards } from '../../src/server/security/agent-enrollment-ingress.js';
import { parseTrustedProxyCidrs } from '../../src/server/security/trusted-client-address.js';
const { Pool } = pg;
const SOCKET=process.env.PULSE_AGENT_SOCKET;
const DATA=process.env.PULSE_AGENT_DATA;
function insist(ok:unknown,message:string): asserts ok {if(!ok) throw new Error('REFUSE_D10_HTTP: '+message);}
function guard(){
  insist(process.env.PULSE_AGENT_DISPOSABLE_ONLY==='YES' && process.env.NODE_ENV!=='production','isolated test only');
  insist(typeof SOCKET==='string' && /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/.test(SOCKET),'unexpected socket');
  insist(DATA===`${dirname(SOCKET)}/data`,'data directory mismatch');
  const marker=`${dirname(SOCKET)}/.pulse-agent-enrollment-marker`;
  insist(existsSync(marker)&&lstatSync(marker).isFile()&&!lstatSync(marker).isSymbolicLink(),'missing marker');
}
async function main(){
  guard();
  const pool=new Pool({host:SOCKET,port:55432,database:'pulse_metrics',user:'pulse_metrics_app',
    ssl:false,max:12,connectionTimeoutMillis:2500,statement_timeout:8000});
  let server:http.Server|null=null;
  try {
    const id=(await pool.query(`SELECT current_database() AS db,current_user AS role,
      inet_server_addr() IS NULL AS socket_only`)).rows[0];
    insist(id?.db==='pulse_metrics'&&id.role==='pulse_metrics_app'&&id.socket_only===true,'untrusted database session');
    const db=drizzle(pool);
    const consume=createPostgresAgentQuotaConsumer(statement=>db.execute(statement));
    const limiter=createAgentQuotaLimiter({hmacKey:randomBytes(32).toString('base64url'),consume});
    const guards=createAgentEnrollmentIngressGuards({
      mode:'trusted-proxy',trustedProxies:parseTrustedProxyCidrs('127.0.0.1/32'),
      limiter,isolatedTestOnly:true,production:false,
    });
    const app=express();app.disable('x-powered-by');
    // Identity fixture supplied by test code ONLY. Never use header-based
    // identity on an actual server. No real WorkOS token is processed here.
    const syntheticActor:express.RequestHandler=(_req,res,next)=>{
      res.locals.authenticatedIdentity={provider:'workos',subject:'user_agent_owner_a',sessionId:'synthetic-d10'};
      next();
    };
    app.post('/test/issue',guards.network('issue'),syntheticActor,guards.actor,guards.admit('issue'),(_req,res)=>res.status(204).end());
    app.post('/test/redeem',guards.network('redeem'),guards.admit('redeem'),(_req,res)=>res.status(204).end());
    app.post('/test/bypass',guards.admit('redeem'),(_req,res)=>res.status(204).end());
    server=http.createServer(app);
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});
    const addr=server.address();insist(addr&&typeof addr!=='string','loopback listener required');
    const base=`http://127.0.0.1:${addr.port}`;
    async function post(path:string,ip:string,proto='https') {
      const res=await fetch(`${base}${path}`,{method:'POST',headers:{
        'X-Forwarded-For':ip,'X-Forwarded-Proto':proto,
      }});
      await res.arrayBuffer();return res;
    }
    assert.equal((await post('/test/redeem','198.51.100.99','http')).status,503);
    assert.equal((await post('/test/redeem','not-a-client-ip')).status,503);
    assert.equal((await post('/test/bypass','198.51.100.99')).status,503);
    console.log('PASS: rejected HTTP forwarding, invalid addresses and missing network guard');
    for(let n=1;n<=9;n++) {
      const res=await post('/test/issue','198.51.100.42');
      assert.equal(res.status,n<=8?204:429);
      if(n===9) assert.ok(Number(res.headers.get('retry-after'))>=1);
    }
    console.log('PASS: simulated proxy ingress enforces verified-actor 8-request quota');
    for(let n=1;n<=26;n++) {
      const res=await post('/test/redeem','198.51.100.44');
      assert.equal(res.status,n<=25?204:429);
    }
    console.log('PASS: simulated HTTPS proxy ingress enforces persistent 25-request redemption network quota');
    // Spoofing a leftmost XFF value MUST not evade nearest-untrusted-hop quota.
    const denied=await post('/test/redeem','203.0.113.123, 198.51.100.44');
    assert.equal(denied.status,429);
    console.log('PASS: spoofed XFF prefix cannot evade nearest-untrusted-hop quota');
  }finally {
    if(server) await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await pool.end();
  }
}
main().catch(e=>{console.error('D10 HTTP rehearsal failed:',e?.message??'unknown');process.exitCode=1;});
