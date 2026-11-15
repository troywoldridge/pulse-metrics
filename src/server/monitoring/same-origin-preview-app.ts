/**
 * D15C-5P — local-only, authenticated same-origin API composition.
 * Never imported by server.ts. A separate guarded CLI controls its listener.
 * No write endpoints, machine ingress, SSH, WebSockets or demo measurements.
 */
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from '../auth/workos-auth.js';
import {
  createListOrganizationsRoute,
  type ListOrganizations,
} from '../auth/organization-route.js';
import { createHistoryRoute, type HistoryLoader } from './history-route.js';
import { denyPendingMonitoringApi } from '../legacy-transport.js';

/**
 * Injected adapters are exclusively for isolated HTTP tests. The real 5P
 * starter passes no adapters, so both routes use their real PostgreSQL code.
 */
export interface SameOriginPreviewTestAdapters {
  readonly listOrganizations?: ListOrganizations;
  readonly loadHistory?: HistoryLoader;
}

export function createSameOriginHistoryPreviewApp(
  verifier: TokenVerifier,
  testAdapters: SameOriginPreviewTestAdapters = {},
): ReturnType<typeof express> {
  if (typeof verifier !== 'function') {
    throw new TypeError('A verified access-token middleware dependency is required');
  }

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Authentication is required for every API endpoint in this composition.
  app.use('/api', requireWorkOSUser(verifier));
  app.get('/api/organizations',
    testAdapters.listOrganizations === undefined
      ? createListOrganizationsRoute()
      : createListOrganizationsRoute(testAdapters.listOrganizations));
  app.get('/api/organizations/:organizationId/agents/:agentId/history',
    testAdapters.loadHistory === undefined
      ? createHistoryRoute()
      : createHistoryRoute(testAdapters.loadHistory));

  // No agent discovery, ingestion, administration, generic metrics or writes.
  app.use('/api', denyPendingMonitoringApi);
  return app;
}
