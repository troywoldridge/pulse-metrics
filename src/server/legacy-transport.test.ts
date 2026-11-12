import assert from 'node:assert/strict';
import { once } from 'node:events';
import http, { type Server } from 'node:http';
import net from 'node:net';
import test from 'node:test';
import express from 'express';
import {
  denyPendingMonitoringApi,
  rejectUnauthenticatedUpgrade,
} from './legacy-transport.js';

async function withRetiredTransport(run: (port: number) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api', denyPendingMonitoringApi);
  const server: Server = http.createServer(app);
  server.on('upgrade', rejectUnauthenticatedUpgrade);
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

test('pending monitoring API never exposes fake history or host data', async () => {
  await withRetiredTransport(async port => {
    for (const path of ['/api/history', '/api/hosts', '/api/metrics', '/api/telemetry']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'organization_authorization_pending' });
    }
  });
});

test('WebSocket upgrade request is rejected with HTTP 403', async () => {
  await withRetiredTransport(async port => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let received = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('Upgrade response timed out')));
      socket.once('connect', () => socket.write([
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '', '',
      ].join('\r\n')));
      socket.on('data', chunk => { received += chunk.toString('utf8'); });
      socket.once('end', () => resolve(received));
      socket.once('error', reject);
    });
    assert.match(response, /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.match(response, /Connection: close\r\n/i);
    assert.match(response, /Content-Length: 0\r\n/i);
    assert.doesNotMatch(response, /101 Switching Protocols/);
  });
});
