/** D15C-5R — offline tests only. No listeners, TLS handshakes, or secrets. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHttpsTelemetrySender,
  PROPOSED_TELEMETRY_PATH,
  TelemetryDeliveryError,
  type TelemetryFetch,
} from './https-telemetry-sender.js';

const SECRET = Buffer.alloc(32, 17).toString('base64url'); // Synthetic only.
const ID = '84b5104a-2f67-40da-86a2-9192c2ac2ce8';
const TIME = '2026-01-01T00:00:00.000Z'; // Synthetic fixture time.
const ENVELOPE = {
  schemaVersion: 1,
  sentAt: TIME,
  samples: [
    { metric: 'cpu.usage_percent', value: null, unit: 'percent', observedAt: TIME,
      status: 'unavailable', source: '/proc/stat', reason: 'Waiting for second sample.' },
    { metric: 'memory.total_bytes', value: 17179869184, unit: 'bytes', observedAt: TIME,
      status: 'measured', source: '/proc/meminfo' },
    { metric: 'network.received_bytes', value: 1024, unit: 'bytes', observedAt: TIME,
      status: 'measured', source: '/proc/net/dev' },
  ],
};
const request = () => ({ machineCredential: SECRET, submissionId: ID, envelope: structuredClone(ENVELOPE) });
const response = (status: number, value: unknown, other: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...other },
  });
const sender = (transport: TelemetryFetch) => createHttpsTelemetrySender({
  origin: 'https://monitor.example.org:4433', fetchImpl: transport,
});
const success: TelemetryFetch = async () => response(202, { status: 'inserted' });
const failCode = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) =>
    error instanceof TelemetryDeliveryError && error.code === code);

test('D15C-5R refuses noncanonical, HTTP, credential-bearing, or path/query origins', () => {
  for (const origin of ['http://monitor.example.org', 'https://user:pass@monitor.example.org',
    'https://monitor.example.org/a', 'https://monitor.example.org?x=1',
    'https://monitor.example.org/#fragment', 'https://monitor.example.org/',
    'https://monitor.example.org:443', 'https://monitor.example.org.', 'ftp://monitor.example.org']) {
    assert.throws(() => createHttpsTelemetrySender({ origin, fetchImpl: success }),
      (e: unknown) => e instanceof TelemetryDeliveryError && e.code === 'invalid_request');
  }
});

test('D15C-5R needs explicit fetch and bounded timeout', () => {
  for (const timeoutMs of [0, 31, 30001, 1.2, Number.NaN, Infinity]) {
    assert.throws(() => createHttpsTelemetrySender({ origin: 'https://monitor.example.org',
      fetchImpl: success, timeoutMs }), TelemetryDeliveryError);
  }
  assert.throws(() => createHttpsTelemetrySender({
    origin: 'https://monitor.example.org', fetchImpl: undefined as unknown as TelemetryFetch,
  }), TelemetryDeliveryError);
});

test('D15C-5R invalid credentials and UUID fail before transport', async () => {
  let called = 0;
  const guarded = sender(async () => { called++; return response(202, { status: 'inserted' }); });
  for (const secret of ['', SECRET + '=', SECRET.slice(0, -1), 'x'.repeat(43)]) {
    await failCode(guarded.send({ ...request(), machineCredential: secret }), 'invalid_request');
  }
  await failCode(guarded.send({ ...request(), submissionId: 'not-a-v4-uuid' }), 'invalid_request');
  assert.equal(called, 0);
});

test('D15C-5R refuses forged selectors and unexpected telemetry properties before fetch', async () => {
  let called = 0;
  const guarded = sender(async () => { called++; return response(202, { status: 'inserted' }); });
  await failCode(guarded.send({ ...request(), organizationId: ID } as never), 'invalid_request');
  await failCode(guarded.send({ ...request(), envelope: { ...ENVELOPE, organizationId: ID } }), 'invalid_request');
  await failCode(guarded.send({ ...request(), envelope: {
    ...ENVELOPE, samples: [...ENVELOPE.samples, ENVELOPE.samples[0]],
  } }), 'invalid_request');
  await failCode(guarded.send({ ...request(), envelope: {
    ...ENVELOPE, samples: [{ ...ENVELOPE.samples[0], agentId: ID }],
  } }), 'invalid_request');
  assert.equal(called, 0);
});

test('D15C-5R 202 uses fixed HTTPS path and header-only credential, never tenant selector', async () => {
  let count = 0;
  const tested = sender(async (url, options) => {
    count++;
    assert.equal(url, 'https://monitor.example.org:4433' + PROPOSED_TELEMETRY_PATH);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal((options.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`);
    assert.equal((options.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.ok(!url.includes(SECRET));
    const bodyText = options.body as string;
    assert.ok(!bodyText.includes(SECRET));
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['envelope', 'submissionId']);
    assert.equal(body.submissionId, ID);
    assert.equal(options.signal?.aborted, false);
    return response(202, { status: 'inserted' });
  });
  assert.equal(await tested.send(request()), 'inserted');
  assert.equal(count, 1);
});

test('D15C-5R duplicate confirmation preserves caller-provided submission ID and payload', async () => {
  const bodies: string[] = [];
  const tested = sender(async (_url, options) => {
    bodies.push(options.body as string);
    return response(200, { status: 'duplicate' });
  });
  const input = request();
  assert.equal(await tested.send(input), 'duplicate');
  assert.equal(await tested.send(input), 'duplicate');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test('D15C-5R credential, malformed payload and conflict have distinct safe results', async () => {
  for (const [status, body, code] of [
    [401, { error: 'invalid_machine_credential' }, 'credential_rejected'],
    [400, { error: 'invalid_telemetry_submission' }, 'submission_rejected'],
    [413, { error: 'telemetry_payload_too_large' }, 'submission_rejected'],
    [415, { error: 'unsupported_telemetry_media' }, 'submission_rejected'],
    [409, { error: 'telemetry_submission_conflict' }, 'submission_conflict'],
  ] as const) {
    let count = 0;
    await failCode(sender(async () => { count++; return response(status, body); }).send(request()), code);
    assert.equal(count, 1);
  }
});

test('D15C-5R accepts bounded 429 Retry-After but does not retry automatically', async () => {
  let count = 0;
  const tested = sender(async () => {
    count++;
    return response(429, { error: 'telemetry_rate_limited' }, { 'Retry-After': '120' });
  });
  await assert.rejects(tested.send(request()), (error: unknown) =>
    error instanceof TelemetryDeliveryError && error.code === 'rate_limited' &&
      error.retryAfterSeconds === 120);
  assert.equal(count, 1);
  for (const retry of ['0', '-1', '901', '1.5', '120 seconds', '']) {
    await failCode(sender(async () => response(429, { error: 'telemetry_rate_limited' },
      { 'Retry-After': retry })).send(request()), 'unavailable');
  }
});

test('D15C-5R rejects redirects, mismatched results and unknown HTTP statuses', async () => {
  for (const [status, body] of [
    [307, { status: 'inserted' }], [200, { status: 'inserted' }],
    [202, { status: 'duplicate' }], [201, { status: 'inserted' }],
    [503, { error: 'telemetry_ingestion_unavailable' }],
    [202, { status: 'inserted', machineCredential: SECRET }],
  ] as const) {
    await failCode(sender(async () => response(status, body)).send(request()), 'unavailable');
  }
});

test('D15C-5R rejects missing no-store and wrong media type', async () => {
  await failCode(sender(async () => new Response('{"status":"inserted"}', {
    status: 202, headers: { 'Content-Type': 'application/json' },
  })).send(request()), 'unavailable');
  await failCode(sender(async () => new Response('{"status":"inserted"}', {
    status: 202, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
  })).send(request()), 'unavailable');
});

test('D15C-5R refuses oversized stream responses', async () => {
  const tested = sender(async () => new Response('x'.repeat(3000), {
    status: 202, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  }));
  await failCode(tested.send(request()), 'unavailable');
});

test('D15C-5R network exception cannot expose provider text or secrets', async () => {
  const tested = sender(async () => { throw new Error(`secret=${SECRET} at internal private URL`); });
  await assert.rejects(tested.send(request()), (error: unknown) =>
    error instanceof TelemetryDeliveryError && error.code === 'unavailable' &&
      !error.message.includes(SECRET) && !error.message.includes('private URL'));
});

test('D15C-5R expired request timeout aborts the one attempt', async () => {
  let attempts = 0;
  const tested = createHttpsTelemetrySender({
    origin: 'https://monitor.example.org',
    timeoutMs: 100,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      attempts++;
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await failCode(tested.send(request()), 'unavailable');
  assert.equal(attempts, 1);
});
