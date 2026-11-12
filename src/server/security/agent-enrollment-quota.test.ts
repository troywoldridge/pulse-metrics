import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  AgentQuotaExceeded, AgentQuotaUnavailable, createAgentQuotaLimiter,
  createPostgresAgentQuotaConsumer, parseAgentQuotaKey,
} from './agent-enrollment-quota.js';
const key = randomBytes(32).toString('base64url');
const actor = { provider: 'workos', subject: 'user_AAA', sessionId: 'session' } as const;

test('require 32-byte canonical independently configured HMAC key', () => {
  assert.equal(parseAgentQuotaKey(key).length, 32);
  for (const wrong of ['', key.slice(1), key + '=', 'x'.repeat(43), null]) {
    assert.throws(() => parseAgentQuotaKey(wrong), AgentQuotaUnavailable);
  }
});
test('HMAC digest separates network, actor and actions; never emits raw identifying data', async () => {
  const records: string[] = [];
  const limiter = createAgentQuotaLimiter({hmacKey: key, consume: async (action, kind, digest) => {
    records.push(`${action}:${kind}:${digest}`);
    return {allowed: true, retryAfterSeconds: 0};
  }});
  await limiter.checkNetwork('issue', '198.51.100.8');
  await limiter.checkNetwork('redeem', '198.51.100.8');
  await limiter.checkActor(actor);
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map(x => x.split(':')[2])).size, 3);
  assert.ok(records.every(x => /^[a-z]+:[a-z]+:[0-9a-f]{64}$/.test(x)));
  assert.ok(!records.join().includes(actor.subject));
  assert.ok(!records.join().includes('198.51.100.8'));
});
test('equivalent mapped IPv4 and IPv4 produce one quota bucket', async () => {
  const digests: string[] = [];
  const limiter = createAgentQuotaLimiter({hmacKey:key,consume:async (_a,_k,d) => {
    digests.push(d); return {allowed:true,retryAfterSeconds:0};
  }});
  await limiter.checkNetwork('redeem','::ffff:198.51.100.8');
  await limiter.checkNetwork('redeem','198.51.100.8');
  assert.equal(digests[0],digests[1]);
});
test('quota exceeded is typed; malformed backend decisions and outages deny', async () => {
  const mk = (consume: any) => createAgentQuotaLimiter({hmacKey:key,consume});
  await assert.rejects(mk(async()=>({allowed:false,retryAfterSeconds:34})).checkNetwork('redeem','192.0.2.2'),
    (e:unknown)=> e instanceof AgentQuotaExceeded && e.retryAfterSeconds===34);
  for (const decision of [null, {}, {allowed:1,retryAfterSeconds:0},
    {allowed:true,retryAfterSeconds:2},{allowed:false,retryAfterSeconds:0},
    {allowed:false,retryAfterSeconds:901}]) {
    await assert.rejects(mk(async()=>decision).checkNetwork('issue','192.0.2.2'),AgentQuotaUnavailable);
  }
  await assert.rejects(mk(async()=>{throw new Error('secret DB outage');}).checkNetwork('redeem','192.0.2.2'),AgentQuotaUnavailable);
});
test('rejects spoofed actor shapes, malformed IPs, no direct database effects', async () => {
  let called=0;
  const limiter=createAgentQuotaLimiter({hmacKey:key,consume:async()=>{called++;return {allowed:true,retryAfterSeconds:0};}});
  for (const bad of [null, {}, {provider:'other',subject:'user_AAA',sessionId:'x'},
    {provider:'workos',subject:'user_AAA',sessionId:''}]) {
    await assert.rejects(limiter.checkActor(bad),AgentQuotaUnavailable);
  }
  await assert.rejects(limiter.checkNetwork('redeem','not.an.ip'),AgentQuotaUnavailable);
  assert.equal(called,0);
});
test('SQL adapter refuses arbitrary key, invalid roles and malformed DB responses', async () => {
  let called=0;
  const consume=createPostgresAgentQuotaConsumer(async (_sql)=>{
    called++; return {rows:[{allowed:true,retry_after_seconds:0}]};
  });
  const hash='a'.repeat(64);
  assert.deepEqual(await consume('issue','actor',hash),{allowed:true,retryAfterSeconds:0});
  assert.equal(called,1);
  await assert.rejects(consume('redeem','actor',hash),AgentQuotaUnavailable);
  await assert.rejects(consume('issue','network','not-digest'),AgentQuotaUnavailable);
  assert.equal(called,1);
  await assert.rejects(createPostgresAgentQuotaConsumer(async()=>({rows:[]}))('redeem','network',hash),AgentQuotaUnavailable);
  await assert.rejects(createPostgresAgentQuotaConsumer(async()=>{throw new Error('password secret');})('redeem','network',hash),AgentQuotaUnavailable);
});
