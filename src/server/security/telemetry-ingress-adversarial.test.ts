/**
 * Pulse Metrics — D15C-2 adversarial HTTP ingress tests.
 *
 * Uses real Node HTTP requests on a temporary loopback server.
 * No real TLS proxy, database, or customer credentials.
 *
 * Repeated HTTP header values use Node's supported array-valued
 * headers. Never pass a flat rawHeaders array to http.request().
 */

import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import express from 'express';

import {
  createIsolatedTelemetryIngressGuard,
} from './telemetry-ingress.js';

import {
  parseTrustedProxyCidrs,
} from './trusted-client-address.js';

import {
  MAX_INGESTION_BYTES,
} from '../telemetry/normalize-ingestion.js';

const PROXY = parseTrustedProxyCidrs('127.0.0.1/32');

type HeaderValue = string | string[];

type Headers = Record<string, HeaderValue>;

interface Result {
  status: number;
  body: string;
  cacheControl: string | undefined;
  quotaCalls: number;
  handlerCalls: number;
}

async function send(
  headers: Headers,
  body: Buffer,
): Promise<Result> {
  let quotaCalls = 0;
  let handlerCalls = 0;

  const app = express();
  app.disable('x-powered-by');

  const guard = createIsolatedTelemetryIngressGuard({
    mode: 'trusted-proxy',
    trustedProxies: PROXY,
    isolatedTestOnly: true,
    production: false,
    checkNetwork: async () => {
      quotaCalls++;
    },
  });

  app.post(
    '/telemetry-test',
    guard,
    express.json({
      limit: MAX_INGESTION_BYTES,
      strict: true,
      inflate: false,
    }),
    (_req, res) => {
      handlerCalls++;
      res.status(204).end();
    },
  );

  // Return sanitized results for malformed or oversized JSON.
  // This is an isolated test-server error handler, not a
  // production route activation.
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.setHeader('Cache-Control', 'no-store');

      const status = (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        typeof error.status === 'number'
      ) ? error.status : 400;

      if (status === 413) {
        res.status(413).json({
          error: 'telemetry_payload_too_large',
        });
        return;
      }

      res.status(400).json({
        error: 'invalid_telemetry_submission',
      });
    },
  );

  const server: Server = http.createServer(app);

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();

    assert.ok(
      address &&
      typeof address !== 'string',
    );

    return await new Promise<Result>((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/telemetry-test',
        method: 'POST',

        // Node's supported request headers representation.
        headers,
      }, response => {
        const chunks: Buffer[] = [];

        response.on('data', chunk => {
          chunks.push(Buffer.from(chunk));
        });

        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            cacheControl:
              response.headers['cache-control'],
            quotaCalls,
            handlerCalls,
          });
        });

        response.on('error', reject);
      });

      request.on('error', reject);
      request.end(body);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function headers(): Headers {
  return {
    'Content-Type': 'application/json',
    'X-Forwarded-For': '198.51.100.22',
    'X-Forwarded-Proto': 'https',
  };
}

test('valid declared-size JSON passes network preflight', async () => {
  const body = Buffer.from('{"sample":true}');

  const result = await send({
    ...headers(),
    'Content-Length': String(body.length),
  }, body);

  assert.equal(result.status, 204);
  assert.equal(result.quotaCalls, 1);
  assert.equal(result.handlerCalls, 1);
});

test('duplicate forwarded protocol cannot establish TLS', async () => {
  const result = await send({
    ...headers(),
    'X-Forwarded-Proto': ['https', 'https'],
  }, Buffer.from('{}'));

  assert.equal(result.status, 503);
  assert.equal(result.quotaCalls, 0);
  assert.equal(result.handlerCalls, 0);
});

test('duplicate forwarded-for header cannot select client', async () => {
  const result = await send({
    ...headers(),
    'X-Forwarded-For': [
      '198.51.100.22',
      '198.51.100.99',
    ],
  }, Buffer.from('{}'));

  assert.equal(result.status, 503);
  assert.equal(result.quotaCalls, 0);
  assert.equal(result.handlerCalls, 0);
});

test('missing forwarded protocol fails closed', async () => {
  const result = await send({
    'Content-Type': 'application/json',
    'X-Forwarded-For': '198.51.100.22',
  }, Buffer.from('{}'));

  assert.equal(result.status, 503);
  assert.equal(result.quotaCalls, 0);
  assert.equal(result.handlerCalls, 0);
});

test('compressed request rejected before quota or JSON decoding', async () => {
  const body = gzipSync(
    Buffer.from('{"sample":true}'),
  );

  const result = await send({
    ...headers(),
    'Content-Encoding': 'gzip',
    'Content-Length': String(body.length),
  }, body);

  assert.equal(result.status, 415);
  assert.equal(result.quotaCalls, 0);
  assert.equal(result.handlerCalls, 0);
  assert.equal(result.cacheControl, 'no-store');
});

test('oversized declared body rejected before quota', async () => {
  const body = Buffer.alloc(
    MAX_INGESTION_BYTES + 1,
    32,
  );

  const result = await send({
    ...headers(),
    'Content-Length': String(body.length),
  }, body);

  assert.equal(result.status, 413);
  assert.equal(result.quotaCalls, 0);
  assert.equal(result.handlerCalls, 0);
  assert.equal(result.cacheControl, 'no-store');
});

test('chunked oversized JSON is stopped by stream parser', async () => {
  const body = Buffer.from(
    JSON.stringify({
      data: 'x'.repeat(MAX_INGESTION_BYTES),
    }),
  );

  const result = await send({
    ...headers(),
    'Transfer-Encoding': 'chunked',
  }, body);

  assert.equal(result.status, 413);
  assert.equal(result.quotaCalls, 1);
  assert.equal(result.handlerCalls, 0);
  assert.equal(result.cacheControl, 'no-store');
});
