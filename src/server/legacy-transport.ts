/**
 * Phase 2E3C5D6 — fail-closed transport policy until tenant-safe monitoring
 * is available. This module intentionally has no command or telemetry logic.
 */
import type { RequestHandler } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const denyPendingMonitoringApi: RequestHandler = (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({ error: 'organization_authorization_pending' });
};

export function rejectUnauthenticatedUpgrade(_request: IncomingMessage, socket: Duplex): void {
  if (socket.destroyed) return;
  socket.end(
    'HTTP/1.1 403 Forbidden\r\n' +
    'Connection: close\r\n' +
    'Cache-Control: no-store\r\n' +
    'Content-Length: 0\r\n\r\n',
  );
}
