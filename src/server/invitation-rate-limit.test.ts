import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { AuthenticatedIdentity } from './auth/workos-auth.js';
import {
  createInvitationRateLimiter,
  InvitationRateLimitExceededError,
  InvitationRateLimitUnavailableError,
  normalizeSocketAddress,
  parseRateLimitHmacKey,
  type InvitationAction,
  type InvitationBucketKind,
} from './security/invitation-rate-limit.js';

const SECRET = randomBytes(32).toString('base64url');
const identity: AuthenticatedIdentity = {
  provider: 'workos', subject: 'user_rate_limit_123', sessionId: 'session_test',
};
const make = (consume: (action: InvitationAction, kind: InvitationBucketKind, digest: string) => Promise<{allowed:boolean;retryAfterSeconds:number}>) =>
  createInvitationRateLimiter({ hmacKey: SECRET, consume });

test('only a canonical 32-byte HMAC key is accepted', () => {
  assert.equal(parseRateLimitHmacKey(SECRET).length, 32);
  for (const bad of ['', 'invalid', randomBytes(31).toString('base64url'),
    randomBytes(33).toString('base64url'), undefined, ' '.repeat(43)]) {
    assert.throws(() => parseRateLimitHmacKey(bad), InvitationRateLimitUnavailableError);
  }
});

test('network addresses must be real socket IPs, not forwarded headers', () => {
  assert.equal(normalizeSocketAddress('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeSocketAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeSocketAddress('::1'), '::1');
  for (const bad of ['unknown', '1.2.3.4, 8.8.8.8', '', '192.0.2.99\r\nX:',
    'javascript:alert(1)', undefined, 'a'.repeat(129)]) {
    assert.throws(() => normalizeSocketAddress(bad), InvitationRateLimitUnavailableError);
  }
});

test('network and actor produce distinct opaque 64-character digests', async () => {
  const observed: Array<{ action:string;kind:string;digest:string }> = [];
  const limiter = make(async (action, kind, digest) => {
    observed.push({action, kind, digest});
    return { allowed:true, retryAfterSeconds:0 };
  });
  await limiter.checkNetwork('issue', '192.0.2.5');
  await limiter.checkNetwork('accept', '192.0.2.5');
  await limiter.checkActor('issue', identity);
  await limiter.checkActor('accept', identity);
  assert.equal(new Set(observed.map(x=>x.digest)).size, 4);
  for (const x of observed) {
    assert.match(x.digest, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(x.digest, /192\.0\.2\.5|user_rate_limit|@|token/);
  }
});

test('repeat actor requests produce a stable digest across instances with same key', async () => {
  const observed: string[]=[];
  const a=make(async (_action,_kind,digest)=>{observed.push(digest);return {allowed:true,retryAfterSeconds:0};});
  const b=make(async (_action,_kind,digest)=>{observed.push(digest);return {allowed:true,retryAfterSeconds:0};});
  await a.checkActor('accept',identity);
  await b.checkActor('accept',identity);
  assert.equal(observed.length,2);
  assert.equal(observed[0], observed[1]);
});

test('network prefix normalized to same digest for IPv4-mapped socket',async()=>{
  const seen:string[]=[];
  const limiter=make(async (_action,_kind,digest)=>{seen.push(digest);return {allowed:true,retryAfterSeconds:0};});
  await limiter.checkNetwork('issue', '127.0.0.1');
  await limiter.checkNetwork('issue', '::ffff:127.0.0.1');
  assert.equal(seen[0],seen[1]);
});

test('network identity is derived solely from explicit socket input', async()=>{
  const seen: string[]=[];
  const limiter=make(async (_action,_kind,digest)=>{seen.push(digest);return {allowed:true,retryAfterSeconds:0};});
  await limiter.checkNetwork('issue','192.0.2.5');
  assert.equal(seen.length,1);
});

test('denial is distinct from storage failure and preserves safe retry duration',async()=>{
  const limiter=make(async()=>({allowed:false,retryAfterSeconds:638}));
  await assert.rejects(limiter.checkActor('issue',identity),error=>
    error instanceof InvitationRateLimitExceededError && error.retryAfterSeconds===638);
});

test('unexpected database decisions fail closed',async()=>{
  for (const decision of [{allowed:true,retryAfterSeconds:9},
    {allowed:false,retryAfterSeconds:0},{allowed:false,retryAfterSeconds:-1},
    {allowed:true,retryAfterSeconds:NaN},{allowed:true,retryAfterSeconds:1200},
    {allowed:'true',retryAfterSeconds:0},null]) {
    const limiter=make(async()=>decision as {allowed:boolean;retryAfterSeconds:number});
    await assert.rejects(limiter.checkActor('accept',identity),InvitationRateLimitUnavailableError);
  }
});

test('database errors are sanitized and do not include driver credentials',async()=>{
  const limiter=make(async()=>{throw new Error('private postgres connection password');});
  await assert.rejects(limiter.checkNetwork('accept','127.0.0.1'),error=>
    error instanceof InvitationRateLimitUnavailableError && !error.message.includes('password'));
});

test('invalid identity never touches rate-limit database', async()=>{
  let calls=0;
  const limiter=make(async()=>{calls++;return {allowed:true,retryAfterSeconds:0};});
  for (const bad of [
    {...identity,subject:'bad'},
    {...identity,subject:'user_unsafe\n'},
    {...identity,provider:'browser'},
    {...identity,sessionId:''},
    {...identity,subject:'user_'+'a'.repeat(256)},
  ]) {
    await assert.rejects(limiter.checkActor('accept',bad as AuthenticatedIdentity),InvitationRateLimitUnavailableError);
  }
  assert.equal(calls,0);
});

test('invalid socket address never touches the database',async()=>{
  let calls=0;
  const limiter=make(async()=>{calls++;return {allowed:true,retryAfterSeconds:0};});
  await assert.rejects(limiter.checkNetwork('issue', undefined),InvitationRateLimitUnavailableError);
  assert.equal(calls,0);
});

test('runtime action validation prevents unexpected policy names',async()=>{
  let calls=0;
  const limiter=make(async()=>{calls++;return {allowed:true,retryAfterSeconds:0};});
  await assert.rejects(limiter.checkActor('other' as InvitationAction,identity),InvitationRateLimitUnavailableError);
  assert.equal(calls,0);
});
