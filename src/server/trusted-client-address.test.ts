import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'express';
import {
  canonicalClientAddress,
  parseTrustedProxyCidrs,
  resolveTrustedProxyClientAddress,
  UntrustedClientAddressError,
} from './security/trusted-client-address.js';

const trusted = parseTrustedProxyCidrs('127.0.0.1/32,::1/128,10.20.30.0/24');
type SocketRequest = Pick<Request, 'socket' | 'headers' | 'rawHeaders'>;
function fakeRequest(
  socket: string,
  forwarded?: string,
  additional: { duplicate?: boolean; realIp?: string; other?: string } = {},
): SocketRequest {
  const rawHeaders = forwarded === undefined ? [] : ['X-Forwarded-For', forwarded];
  if (additional.duplicate) rawHeaders.push('x-forwarded-for', '198.51.100.99');
  if (additional.realIp) rawHeaders.push('X-Real-IP', additional.realIp);
  if (additional.other) rawHeaders.push('Forwarded', additional.other);
  return {
    socket: { remoteAddress: socket },
    headers: {
      ...(forwarded !== undefined ? { 'x-forwarded-for': forwarded } : {}),
      ...(additional.realIp ? { 'x-real-ip': additional.realIp } : {}),
      ...(additional.other ? { forwarded: additional.other } : {}),
    },
    rawHeaders,
  } as unknown as SocketRequest;
}

test('IPv4 and IPv6 are canonicalized, including mapped variants', () => {
  assert.equal(canonicalClientAddress('198.51.100.8'), '198.51.100.8');
  assert.equal(canonicalClientAddress('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(canonicalClientAddress('2001:db8::1'), '2001:db8::1');
  assert.equal(canonicalClientAddress('::FFFF:198.51.100.8'), '198.51.100.8');
  assert.equal(canonicalClientAddress('::ffff:c633:6408'), '198.51.100.8');
});

test('malformed and ambiguous addresses are never accepted', () => {
  for (const value of [null, undefined, '', ' 127.0.0.1', '127.0.0.1 ',
    '127.0.0.1:3000', '127.000.0.1', 'example.com', '::1%eth0',
    '[2001:db8::1]', '198.51.100.8, 203.0.113.1', 'unknown',
    'a'.repeat(129)]) {
    assert.throws(() => canonicalClientAddress(value), UntrustedClientAddressError);
  }
});

test('allowlist accepts only explicit valid CIDRs', () => {
  assert.equal(trusted.contains('127.0.0.1'), true);
  assert.equal(trusted.contains('::ffff:127.0.0.1'), true);
  assert.equal(trusted.contains('10.20.30.8'), true);
  assert.equal(trusted.contains('10.20.31.8'), false);
  assert.equal(trusted.contains('198.51.100.8'), false);
  assert.equal(trusted.contains('::2'), false);
  assert.equal(trusted.contains('::1'), true);
});

test('unsafe, wildcard, duplicate, hostname and mapped CIDR entries fail closed', () => {
  for (const value of [undefined, '', '127.0.0.1', '0.0.0.0/0', '::/0',
    '127.0.0.1/33', '::1/129', '127.0.0.1/-1', '127.0.0.1/xx',
    'localhost/32', '::ffff:127.0.0.1/128',
    '127.0.0.1/32,', '127.0.0.1/32,127.0.0.1/32',
    '127.0.0.1/32, 127.0.0.2/32', '127.0.0.1/32,example.com/32',
    new Array(34).fill('127.0.0.1/32').join(','),
  ]) assert.throws(() => parseTrustedProxyCidrs(value), UntrustedClientAddressError);
});

test('only a trusted directly connected peer may speak X-Forwarded-For', () => {
  assert.equal(resolveTrustedProxyClientAddress(fakeRequest('127.0.0.1', '198.51.100.9'), trusted), '198.51.100.9');
  assert.throws(() => resolveTrustedProxyClientAddress(fakeRequest('203.0.113.1', '198.51.100.9'), trusted), UntrustedClientAddressError);
});

test('right-to-left traversal ignores client-forged leftmost addresses', () => {
  const request = fakeRequest('127.0.0.1', '203.0.113.66, 198.51.100.9, 10.20.30.2');
  assert.equal(resolveTrustedProxyClientAddress(request, trusted), '198.51.100.9');
  assert.equal(resolveTrustedProxyClientAddress(fakeRequest('127.0.0.1', '203.0.113.66, 198.51.100.9'), trusted), '198.51.100.9');
  assert.equal(resolveTrustedProxyClientAddress(fakeRequest('127.0.0.1', '198.51.100.9, 10.20.30.2, ::1'), trusted), '198.51.100.9');
});

test('X-Real-IP and RFC Forwarded are never a source of authority', () => {
  const request = fakeRequest('127.0.0.1', '198.51.100.9', {
    realIp: '203.0.113.4', other: 'for=192.0.2.25',
  });
  assert.equal(resolveTrustedProxyClientAddress(request, trusted), '198.51.100.9');
});

test('missing, duplicated, empty or malformed XFF fails closed', () => {
  for (const request of [
    fakeRequest('127.0.0.1'),
    fakeRequest('127.0.0.1', ''),
    fakeRequest('127.0.0.1', '203.0.113.1,,198.51.100.9'),
    fakeRequest('127.0.0.1', 'unknown'),
    fakeRequest('127.0.0.1', '[2001:db8::1]:443'),
    fakeRequest('127.0.0.1', '198.51.100.9', { duplicate: true }),
    fakeRequest('127.0.0.1', '127.0.0.1'),
    fakeRequest('127.0.0.1', new Array(17).fill('198.51.100.9').join(',')),
    fakeRequest('127.0.0.1', '198.51.100.9'.repeat(100)),
  ]) assert.throws(() => resolveTrustedProxyClientAddress(request, trusted), UntrustedClientAddressError);
});

test('equivalent IPv6 spellings from a trusted proxy resolve to one client identity', () => {
  const a = resolveTrustedProxyClientAddress(fakeRequest('::1', '2001:0DB8:0000::1'), trusted);
  const b = resolveTrustedProxyClientAddress(fakeRequest('::1', '2001:db8::1'), trusted);
  assert.equal(a, b);
});
