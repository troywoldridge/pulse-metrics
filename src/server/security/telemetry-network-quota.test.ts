import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';

import {
  createTelemetryNetworkQuotaLimiter,
  createPostgresTelemetryNetworkQuotaConsumer,
  parseTelemetryQuotaKey,
  TelemetryQuotaUnavailable,
} from './telemetry-network-quota.js';

import {
  TelemetryIngressRateLimited,
} from './telemetry-ingress.js';

const KEY = randomBytes(32).toString('base64url');

function make(
  consume: (
    digest: string,
  ) => Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
  }>,
) {
  return createTelemetryNetworkQuotaLimiter({
    hmacKey: KEY,
    consume,
  });
}

test('requires a canonical 32-byte HMAC key', () => {
  assert.equal(parseTelemetryQuotaKey(KEY).length, 32);

  for (const invalid of [
    '',
    'short',
    'A'.repeat(42),
    'A'.repeat(43) + '=',
    'A'.repeat(42) + 'B',
    null,
    123,
  ]) {
    assert.throws(
      () => parseTelemetryQuotaKey(invalid),
      TelemetryQuotaUnavailable,
    );
  }
});

test('sends only an opaque digest to quota consumer', async () => {
  const digests: string[] = [];

  const limiter = make(async digest => {
    digests.push(digest);
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  });

  await limiter.checkNetwork('198.51.100.22');

  assert.equal(digests.length, 1);
  assert.match(digests[0], /^[0-9a-f]{64}$/);
  assert.equal(
    digests[0].includes('198.51.100.22'),
    false,
  );
});

test('same address produces stable quota identity', async () => {
  const digests: string[] = [];

  const limiter = make(async digest => {
    digests.push(digest);
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  });

  await limiter.checkNetwork('198.51.100.22');
  await limiter.checkNetwork('198.51.100.22');

  assert.equal(digests[0], digests[1]);
});

test('different addresses use different quota identities', async () => {
  const digests: string[] = [];

  const limiter = make(async digest => {
    digests.push(digest);
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  });

  await limiter.checkNetwork('198.51.100.22');
  await limiter.checkNetwork('198.51.100.23');

  assert.notEqual(digests[0], digests[1]);
});

test('equivalent IPv4-mapped IPv6 shares quota identity', async () => {
  const digests: string[] = [];

  const limiter = make(async digest => {
    digests.push(digest);
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  });

  await limiter.checkNetwork('198.51.100.22');
  await limiter.checkNetwork('::ffff:198.51.100.22');

  assert.equal(digests[0], digests[1]);
});

test('quota exhaustion produces bounded typed denial', async () => {
  const limiter = make(async () => ({
    allowed: false,
    retryAfterSeconds: 45,
  }));

  await assert.rejects(
    limiter.checkNetwork('198.51.100.22'),
    error => {
      assert.ok(
        error instanceof TelemetryIngressRateLimited,
      );

      assert.equal(error.retryAfterSeconds, 45);
      return true;
    },
  );
});

test('invalid address never reaches quota consumer', async () => {
  let calls = 0;

  const limiter = make(async () => {
    calls++;
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  });

  await assert.rejects(
    limiter.checkNetwork('not-an-ip'),
    TelemetryQuotaUnavailable,
  );

  assert.equal(calls, 0);
});

test('quota backend outages fail closed', async () => {
  const limiter = make(async () => {
    throw new Error('PRIVATE_DATABASE_CONNECTION_DETAILS');
  });

  await assert.rejects(
    limiter.checkNetwork('198.51.100.22'),
    error => {
      assert.ok(error instanceof TelemetryQuotaUnavailable);
      assert.equal(
        error.message.includes('PRIVATE_DATABASE'),
        false,
      );
      return true;
    },
  );
});

test('malformed quota decisions always fail closed', async () => {
  const decisions: unknown[] = [
    null,
    {},
    { allowed: 'true', retryAfterSeconds: 0 },
    { allowed: true, retryAfterSeconds: 1 },
    { allowed: false, retryAfterSeconds: 0 },
    { allowed: false, retryAfterSeconds: 901 },
    { allowed: false, retryAfterSeconds: 2.5 },
  ];

  for (const decision of decisions) {
    const limiter = make(
      async () => decision as {
        allowed: boolean;
        retryAfterSeconds: number;
      },
    );

    await assert.rejects(
      limiter.checkNetwork('198.51.100.22'),
      TelemetryQuotaUnavailable,
    );
  }
});

test('SQL adapter refuses missing executor', () => {
  assert.throws(
    () => createPostgresTelemetryNetworkQuotaConsumer(
      null as never,
    ),
    TelemetryQuotaUnavailable,
  );
});

test('SQL adapter rejects malformed digest before SQL', async () => {
  let calls = 0;

  const consumer =
    createPostgresTelemetryNetworkQuotaConsumer(
      async () => {
        calls++;
        return {
          rows: [{
            allowed: true,
            retry_after_seconds: 0,
          }],
        };
      },
    );

  await assert.rejects(
    consumer('invalid-digest'),
    TelemetryQuotaUnavailable,
  );

  assert.equal(calls, 0);
});

test('SQL adapter accepts a strict database decision', async () => {
  let calls = 0;

  const consumer =
    createPostgresTelemetryNetworkQuotaConsumer(
      async () => {
        calls++;

        return {
          rows: [{
            allowed: true,
            retry_after_seconds: 0,
          }],
        };
      },
    );

  const result = await consumer('a'.repeat(64));

  assert.deepEqual(result, {
    allowed: true,
    retryAfterSeconds: 0,
  });

  assert.equal(calls, 1);
});

test('SQL adapter refuses extra rows and database failures', async () => {
  const digest = 'a'.repeat(64);

  const invalidResults = [
    { rows: [] },
    { rows: [{ allowed: true, retry_after_seconds: 0 },
             { allowed: true, retry_after_seconds: 0 }] },
    { rows: [{ allowed: false, retry_after_seconds: null }] },
    { rows: [{ allowed: 'yes', retry_after_seconds: 0 }] },
  ];

  for (const result of invalidResults) {
    const consumer =
      createPostgresTelemetryNetworkQuotaConsumer(
        async () => result,
      );

    await assert.rejects(
      consumer(digest),
      TelemetryQuotaUnavailable,
    );
  }

  const unavailable =
    createPostgresTelemetryNetworkQuotaConsumer(
      async () => {
        throw new Error('PRIVATE_SQL_ERROR');
      },
    );

  await assert.rejects(
    unavailable(digest),
    TelemetryQuotaUnavailable,
  );
});
