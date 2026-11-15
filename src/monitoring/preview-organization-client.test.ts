import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canRequestPreviewHistory, parsePreviewOrganizations, readPreviewOrganizations,
} from './preview-organization-client.js';

const ORG_A = '3a1b0011-0fd2-4a45-b711-32ef63ce0178';
const ORG_B = '3a1b0022-0fd2-4a45-b711-32ef63ce0178';
const AGENT = '3a1b0033-0fd2-4a45-b711-32ef63ce0178';
const one = { id: ORG_A, name: 'Fictional org', slug: 'fictional-org', role: 'viewer' } as const;
const good = { organizations: [one] };
const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

test('5P accepts only exact bounded authorized organization shapes', () => {
  assert.deepEqual(parsePreviewOrganizations(good), [one]);
  assert.deepEqual(parsePreviewOrganizations({ organizations: [] }), []);
  for (const value of [null, [], {}, { ...good, userId: 'injected' },
    { organizations: [{ ...one, id: 'invalid' }] },
    { organizations: [{ ...one, role: 'superadmin' }] },
    { organizations: [{ ...one, internalToken: 'private' }] },
    { organizations: [one, one] },
    { organizations: [{ ...one, name: '\u0000unsafe' }] },
    { organizations: Array.from({ length: 51 }, () => one) },
    { organizations: [{ ...one, slug: 'FORGED' }] },
  ]) assert.equal(parsePreviewOrganizations(value), null);
});

test('5P selection requires a listed organization and valid agent UUID', () => {
  const list = parsePreviewOrganizations(good);
  assert.ok(list !== null);
  assert.equal(canRequestPreviewHistory(ORG_A, AGENT, list), true);
  assert.equal(canRequestPreviewHistory(ORG_B, AGENT, list), false);
  assert.equal(canRequestPreviewHistory(ORG_A, 'not-an-agent', list), false);
  assert.equal(canRequestPreviewHistory(ORG_A, AGENT, []), false);
});

test('5P WorkOS bearer goes only into same-origin authorization header', async () => {
  let calls = 0;
  const result = await readPreviewOrganizations({
    getAccessToken: async () => 'verified.token',
    fetcher: async (url, init) => {
      calls++;
      assert.equal(url, '/api/organizations');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.referrerPolicy, 'no-referrer');
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer verified.token');
      return json(good);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: true, organizations: [one] });
});

test('5P invalid token or canceled request touches no network', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return json(good); };
  for (const token of [null, '', 'invalid\r\nheader']) {
    const result = await readPreviewOrganizations({
      getAccessToken: async () => token, fetcher,
    });
    assert.deepEqual(result, { ok: false, reason: 'authentication_required' });
  }
  const controller = new AbortController();
  controller.abort();
  const result = await readPreviewOrganizations({
    signal: controller.signal,
    getAccessToken: async () => { throw new Error('SHOULD_NOT_READ'); },
    fetcher,
  });
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.equal(calls, 0);
});

test('5P unrecognized HTTP responses fail safely', async () => {
  for (const response of [
    new Response('', { status: 401 }),
    new Response('', { status: 403 }),
    new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify(good), { status: 200, headers: { 'Content-Type': 'text/html' } }),
    new Response('x'.repeat(48_001), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    json({ organizations: [{ ...one, id: ORG_B, role: 'root' }] }),
  ]) {
    const result = await readPreviewOrganizations({
      getAccessToken: async () => 'valid.token', fetcher: async () => response,
    });
    assert.equal(result.ok, false);
  }
});

test('5P network and provider failures do not disclose exceptions', async () => {
  const a = await readPreviewOrganizations({
    getAccessToken: async () => { throw Error('PRIVATE_WORKOS_SECRET'); },
  });
  const b = await readPreviewOrganizations({
    getAccessToken: async () => 'token',
    fetcher: async () => { throw Error('PRIVATE_DATABASE_SECRET'); },
  });
  assert.deepEqual(a, { ok: false, reason: 'unavailable' });
  assert.deepEqual(b, { ok: false, reason: 'unavailable' });
  assert.doesNotMatch(JSON.stringify([a, b]), /PRIVATE_/);
});
