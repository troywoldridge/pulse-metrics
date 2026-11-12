import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import {
  createIssuePreallocatedEnrollmentRoute,
  createRedeemPreallocatedEnrollmentRoute,
} from './agent-preauthorization-routes.js';
import { createPreauthorizedEnrollmentService } from './agent-preauthorization.js';
import { EnrollmentPermissionDenied } from './agent-enrollment-service.js';

const ORG='11111111-1111-4111-8111-111111111111';
const AGENT='22222222-2222-4222-8222-222222222222';
const ENROLL='33333333-3333-4333-8333-333333333333';
const actor={provider:'workos' as const,subject:'user_test',sessionId:'verified'};
const agent={displayName:'Linux host',hostname:'test.invalid',platform:'linux' as const,architecture:'x86_64' as const};
const body={label:'First host',agent};

async function withServer(
  options:{admitted?:boolean;verified?:boolean;denied?:boolean;redeemMissing?:boolean}={},
  testFn:(url:string,counts:()=>{issue:number;redeem:number})=>Promise<void>,
) {
  let issue=0,redeem=0;
  const service=createPreauthorizedEnrollmentService({
    issue:async()=>{
      issue++;
      if(options.denied) throw new EnrollmentPermissionDenied();
      return {enrollmentId:ENROLL,agentId:AGENT};
    },
    redeem:async()=>{
      redeem++;
      return options.redeemMissing ? null : {organizationId:ORG,agentId:AGENT};
    },
  });
  const app=express();app.use(express.json({limit:'2kb'}));
  const ingress=(_req: Request,res: Response,next: NextFunction)=>{
    if(options.admitted) res.locals.agentEnrollmentIngressVerified=true;
    if(options.verified) res.locals.authenticatedIdentity=actor;
    next();
  };
  app.post('/test/organizations/:organizationId/preauthorize',ingress,createIssuePreallocatedEnrollmentRoute(service));
  app.post('/test/redeem',ingress,createRedeemPreallocatedEnrollmentRoute(service));
  const server:Server=createServer(app);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address();
    assert.ok(address && typeof address==='object');
    await testFn(`http://127.0.0.1:${address.port}`,()=>({issue,redeem}));
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

function post(url:string, data:unknown, endpoint='issue', contentType='application/json') {
  return fetch(url+(endpoint==='issue'?`/test/organizations/${ORG}/preauthorize`:'/test/redeem'),{
    method:'POST',headers:{'Content-Type':contentType},body:JSON.stringify(data),
  });
}

test('D13 all routes without verified ingress refuse requests before gateway',async()=>{
  await withServer({verified:true},async(url,calls)=>{
    assert.equal((await post(url,body)).status,503);
    assert.equal((await post(url,{token:randomBytes(32).toString('base64url'),agent},'redeem')).status,503);
    assert.deepEqual(calls(),{issue:0,redeem:0});
  });
});

test('D13 preauthorization without verified WorkOS identity returns 401 before DB',async()=>{
  await withServer({admitted:true},async(url,calls)=>{
    const res=await post(url,body);
    assert.equal(res.status,401);
    assert.deepEqual(calls(),{issue:0,redeem:0});
  });
});

test('D13 preauthorization rejects body identity overrides before DB',async()=>{
  await withServer({admitted:true,verified:true},async(url,calls)=>{
    for(const value of [{...body,agentId:AGENT},{...body,role:'owner'},
      {...body,agent:{...agent,organizationId:ORG}}]) {
      assert.equal((await post(url,value)).status,400);
    }
    assert.deepEqual(calls(),{issue:0,redeem:0});
  });
});

test('D13 authenticated preauthorization returns one-time secret and independent agent ID',async()=>{
  await withServer({admitted:true,verified:true},async(url,calls)=>{
    const res=await post(url,body);
    assert.equal(res.status,201);
    assert.equal(res.headers.get('cache-control'),'no-store');
    const value=await res.json();
    assert.equal(value.agentId,AGENT);
    assert.equal(value.enrollmentId,ENROLL);
    assert.equal(value.organizationId,ORG);
    assert.match(value.oneTimeToken,/^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(calls(),{issue:1,redeem:0});
  });
});

test('D13 foreign organization actor maps to 403 with no secret',async()=>{
  await withServer({admitted:true,verified:true,denied:true},async(url,calls)=>{
    const res=await post(url,body);
    assert.equal(res.status,403);
    assert.deepEqual(await res.json(),{error:'organization_access_denied'});
    assert.deepEqual(calls(),{issue:1,redeem:0});
  });
});

test('D13 issue and redeem reject invalid media type without touching gateway',async()=>{
  await withServer({admitted:true,verified:true},async(url,calls)=>{
    assert.equal((await post(url,body,'issue','text/plain')).status,415);
    assert.equal((await post(url,{token:randomBytes(32).toString('base64url'),agent},'redeem','text/plain')).status,415);
    assert.deepEqual(calls(),{issue:0,redeem:0});
  });
});

test('D13 redemption with verified ingress yields only bounded 201 credential response',async()=>{
  await withServer({admitted:true},async(url,calls)=>{
    const res=await post(url,{token:randomBytes(32).toString('base64url'),agent},'redeem');
    assert.equal(res.status,201);
    assert.equal(res.headers.get('cache-control'),'no-store');
    const value=await res.json();
    assert.equal(value.organizationId,ORG);
    assert.equal(value.agentId,AGENT);
    assert.equal(Object.keys(value).sort().join(','),'agentId,machineCredential,organizationId');
    assert.match(value.machineCredential,/^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(calls(),{issue:0,redeem:1});
  });
});

test('D13 unavailable redemption maps to uniform 404 and never discloses token',async()=>{
  await withServer({admitted:true,redeemMissing:true},async(url,calls)=>{
    const token=randomBytes(32).toString('base64url');
    const res=await post(url,{token,agent},'redeem');
    assert.equal(res.status,404);
    const response=await res.text();
    assert.equal(response.includes(token),false);
    assert.deepEqual(calls(),{issue:0,redeem:1});
  });
});
