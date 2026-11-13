import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import express from 'express';

import {
  createIsolatedTelemetryIngressGuard,
  TelemetryIngressRateLimited,
  type TelemetryIngressOptions,
} from './telemetry-ingress.js';

import {
  parseTrustedProxyCidrs,
} from './trusted-client-address.js';

import {
  createIsolatedTelemetryHttpCandidate,
} from '../telemetry/http-ingestion.js';

const SECRET = 'A'.repeat(43);

const SUBMISSION_ID =
  '550e8400-e29b-41d4-a716-446655440000';

const TRUSTED_LOOPBACK =
  parseTrustedProxyCidrs('127.0.0.1/32');

type Options = Partial<TelemetryIngressOptions>;

async function withServer(
  options: Options,
  run: (
    baseUrl: string,
    quotaCalls: string[],
    persistenceCalls: { count: number },
  ) => Promise<void>,
): Promise<void> {
  const quotaCalls: string[] = [];
  const persistenceCalls = { count: 0 };

  const app = express();
  app.disable('x-powered-by');

  const candidate =
    createIsolatedTelemetryHttpCandidate({
      isolatedTestOnly: true,
      production: false,
      ingest: async () => {
        persistenceCalls.count++;
        return 'inserted';
      },
    });

  const guard = createIsolatedTelemetryIngressGuard({
    mode: options.mode ?? 'trusted-proxy',
    trustedProxies:
      options.trustedProxies === undefined
        ? TRUSTED_LOOPBACK
        : options.trustedProxies,
    isolatedTestOnly: options.isolatedTestOnly ?? true,
    production: options.production ?? false,
    checkNetwork:
      options.checkNetwork === undefined
        ? async address => {
            quotaCalls.push(address);
          }
        : options.checkNetwork,
  });

  // Network verification deliberately precedes JSON decoding.
  app.post(
    '/protected',
    guard,
    express.json({ limit: '64kb', strict: true }),
    candidate.admitIsolatedTestRequest,
    candidate.handler,
  );

  // The candidate handler itself must remain fail-closed
  // when its private admission stage has not run.
  app.post('/unadmitted', candidate.handler);

  const server: Server = createServer(app);

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();

    assert.ok(
      address &&
      typeof address !== 'string',
    );

    await run(
      `http://127.0.0.1:${address.port}`,
      quotaCalls,
      persistenceCalls,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function payload() {
  const now = new Date().toISOString();

  return {
    submissionId: SUBMISSION_ID,
    envelope: {
      schemaVersion: 1,
      sentAt: now,
      samples: [{
        metric: 'cpu.usage_percent',
        unit: 'percent',
        value: 25,
        observedAt: now,
        status: 'measured',
      }],
    },
  };
}

async function send(
  baseUrl: string,
  headers: Record<string, string> = {},
  body: string = JSON.stringify(payload()),
) {
  return fetch(`${baseUrl}/protected`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET}`,
      'X-Forwarded-For': '198.51.100.22',
      'X-Forwarded-Proto': 'https',
      ...headers,
    },
    body,
  });
}

test('trusted proxy permits quota-checked isolated telemetry', async () => {
  await withServer({}, async (base, quota, persistence) => {
    const response = await send(base);

    assert.equal(response.status, 202);
    assert.deepEqual(quota, ['198.51.100.22']);
    assert.equal(persistence.count, 1);
    assert.equal(
      response.headers.get('cache-control'),
      'no-store',
    );
  });
});

test('direct HTTP cannot impersonate direct TLS', async () => {
  await withServer(
    { mode: 'direct-tls' },
    async (base, quota, persistence) => {
      const response = await send(base);

      assert.equal(response.status, 503);
      assert.deepEqual(quota, []);
      assert.equal(persistence.count, 0);
    },
  );
});

test('untrusted socket peer cannot claim proxy authority', async () => {
  await withServer(
    {
      trustedProxies:
        parseTrustedProxyCidrs('192.0.2.1/32'),
    },
    async (base, quota, persistence) => {
      const response = await send(base);

      assert.equal(response.status, 503);
      assert.deepEqual(quota, []);
      assert.equal(persistence.count, 0);
    },
  );
});

test('forged forwarding protocol cannot establish HTTPS', async () => {
  await withServer({}, async (base, quota, persistence) => {
    const response = await send(base, {
      'X-Forwarded-Proto': 'http',
    });

    assert.equal(response.status, 503);
    assert.deepEqual(quota, []);
    assert.equal(persistence.count, 0);
  });
});

test('untrusted XFF prefix cannot change quota identity', async () => {
  await withServer({}, async (base, quota, persistence) => {
    const response = await send(base, {
      'X-Forwarded-For':
        '203.0.113.99, 198.51.100.22',
    });

    assert.equal(response.status, 202);
    assert.deepEqual(quota, ['198.51.100.22']);
    assert.equal(persistence.count, 1);
  });
});

test('invalid forwarding chain fails before persistence', async () => {
  await withServer({}, async (base, quota, persistence) => {
    const response = await send(base, {
      'X-Forwarded-For': 'not-an-address',
    });

    assert.equal(response.status, 503);
    assert.deepEqual(quota, []);
    assert.equal(persistence.count, 0);
  });
});

test('rate-limit exhaustion rejects before body parsing', async () => {
  await withServer(
    {
      checkNetwork: async () => {
        throw new TelemetryIngressRateLimited(45);
      },
    },
    async (base, _quota, persistence) => {
      const response = await send(
        base,
        {},
        '{malformed-json',
      );

      assert.equal(response.status, 429);
      assert.equal(
        response.headers.get('retry-after'),
        '45',
      );
      assert.equal(persistence.count, 0);

      assert.deepEqual(await response.json(), {
        error: 'telemetry_rate_limited',
      });
    },
  );
});

test('quota storage failure returns sanitized 503', async () => {
  await withServer(
    {
      checkNetwork: async () => {
        throw new Error('PRIVATE_QUOTA_STORAGE_FAILURE');
      },
    },
    async (base, _quota, persistence) => {
      const response = await send(base);
      const body = await response.text();

      assert.equal(response.status, 503);
      assert.equal(persistence.count, 0);
      assert.equal(
        body.includes('PRIVATE_QUOTA_STORAGE_FAILURE'),
        false,
      );
    },
  );
});

test('missing quota dependency fails closed', async () => {
  await withServer(
    { checkNetwork: null },
    async (base, _quota, persistence) => {
      const response = await send(base);

      assert.equal(response.status, 503);
      assert.equal(persistence.count, 0);
    },
  );
});

test('production configuration refuses telemetry ingress', async () => {
  await withServer(
    { production: true },
    async (base, quota, persistence) => {
      const response = await send(base);

      assert.equal(response.status, 503);
      assert.deepEqual(quota, []);
      assert.equal(persistence.count, 0);
    },
  );
});

test('handler without private admission still fails closed', async () => {
  await withServer({}, async (base, _quota, persistence) => {
    const response = await fetch(`${base}/unadmitted`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(payload()),
    });

    assert.equal(response.status, 503);
    assert.equal(persistence.count, 0);
  });
});
