/**
 * D15C-5N — isolated HTTP composition for LOCAL DEVELOPMENT ONLY.
 * The real entrypoint must enforce requireLocalHistoryPreview before listening.
 * server.ts is deliberately not modified and still rejects monitoring APIs.
 */
import express from 'express';
import type { TokenVerifier } from '../auth/workos-auth.js';
import { requireWorkOSUser } from '../auth/workos-auth.js';
import { createHistoryRoute, type HistoryLoader } from './history-route.js';
import { denyPendingMonitoringApi } from '../legacy-transport.js';

/**
 * The optional loader exists only to support isolated negative HTTP tests.
 * The actual preview CLI does not inject it, and therefore uses the real
 * tenant-checked PostgreSQL history service.
 */
export function createLocalHistoryPreviewApp(
  verifyToken: TokenVerifier,
  load?: HistoryLoader,
): ReturnType<typeof express> {
  if (typeof verifyToken !== 'function') {
    throw new TypeError('Verified access-token middleware is required');
  }
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // Never expose server metrics, host discovery, administrative commands,
  // machine enrollment, generic /api/history, or WebSocket data.
  app.use('/api', requireWorkOSUser(verifyToken));
  app.get(
    '/api/organizations/:organizationId/agents/:agentId/history',
    load === undefined ? createHistoryRoute() : createHistoryRoute(load),
  );
  app.use('/api', denyPendingMonitoringApi);
  return app;
}
