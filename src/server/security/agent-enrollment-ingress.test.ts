import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { parseTrustedProxyCidrs } from './trusted-client-address.js';
import { createAgentEnrollmentIngressGuards } from './agent-enrollment-ingress.js';
import { AgentQuotaExceeded } from './agent-enrollment-quota.js';
const proxy = parseTrustedProxyCidrs('127.0.0.1/32');
const actor={provider:'workos',subject:'user_test_subject',sessionId:'verified-session'};
function make(options: {limit?: boolean; denied?: boolean; production?: boolean; mode?: 'direct-tls'|'trusted-proxy'; actor?: boolean} = {}) {
  const calls:string[]=[];
  const limiter={
    checkNetwork:async(action:'issue'|'redeem',address:unknown)=>{
      calls.push(`network:${action}:${String(address)}`);
      if(options.limit) throw new AgentQuotaExceeded(45);
      if(options.denied) throw new Error('storage outage');
    },
    checkActor:async()=>{calls.push('actor'); if(options.denied) throw new Error('storage outage');},
  };
  const guards=createAgentEnrollmentIngressGuards({mode:options.mode??'trusted-proxy',trustedProxies:proxy,
    limiter,production:options.production??false,isolatedTestOnly:true});
  const app=express();
  app.disable('x-powered-by');
  app.post('/issue',guards.network('issue'),(_req,res,next)=>{
    if(options.actor) res.locals.authenticatedIdentity=actor;
    next();
  },guards.actor,guards.admit('issue'),(_req,res)=>res.status(204).end());
  app.post('/redeem',guards.network('redeem'),guards.admit('redeem'),(_req,res)=>res.status(204).end());
  app.post('/bypass',guards.admit('redeem'),(_req,res)=>res.status(204).end());
  return {app,calls};
}
async function request(app: ReturnType<typeof express>, path:string,headers:Record<string,string> = {}) {
  const server=http.createServer(app);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const addr=server.address();assert.ok(addr&&typeof addr!=='string');
    const response = await fetch(`http://127.0.0.1:${addr.port}${path}`,{method:'POST',headers:{
      'x-forwarded-for':'198.51.100.2','x-forwarded-proto':'https',...headers,
    }});
    await response.arrayBuffer();
    return response;
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
test('rejects any activation in production configuration',async()=>{
  const {app,calls}=make({production:true,actor:true});
  assert.equal((await request(app,'/issue')).status,503);
  assert.deepEqual(calls,[]);
});
test('valid trusted-proxy request gets network check first, actor check second',async()=>{
  const {app,calls}=make({actor:true});
  assert.equal((await request(app,'/issue')).status,204);
  assert.deepEqual(calls,['network:issue:198.51.100.2','actor']);
});
test('redeem only uses network quota; never trusts an actor header',async()=>{
  const {app,calls}=make();
  assert.equal((await request(app,'/redeem',{'x-test-subject':'user_bad'})).status,204);
  assert.deepEqual(calls,['network:redeem:198.51.100.2']);
});
test('issuance without verified WorkOS actor returns 401 after network limit',async()=>{
  const {app,calls}=make();
  const r=await request(app,'/issue');
  assert.equal(r.status,401); assert.deepEqual(calls,['network:issue:198.51.100.2']);
});
test('spoofed HTTPS from untrusted source, missing XFF, or HTTP are refused',async()=>{
  const {app}=make();
  assert.equal((await request(app,'/redeem',{'x-forwarded-proto':'http'})).status,503);
  assert.equal((await request(app,'/redeem',{'x-forwarded-for':'not-ip'})).status,503);
  const direct=make({mode:'direct-tls'});
  assert.equal((await request(direct.app,'/redeem')).status,503);
});
test('quota denial returns bounded 429 and outage 503; never admits downstream',async()=>{
  const a=make({limit:true});const b=make({denied:true});
  const denied=await request(a.app,'/redeem');
  assert.equal(denied.status,429);
  assert.equal(denied.headers.get('retry-after'),'45');
  assert.equal((await request(b.app,'/redeem')).status,503);
});
test('final guard cannot be bypassed by calling it without prior middleware',async()=>{
  const {app}=make();assert.equal((await request(app,'/bypass')).status,503);
});
