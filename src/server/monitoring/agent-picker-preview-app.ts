/**
 * D15C-5Q — independent local-only read-only preview API.
 * No main server mount, mutable API, credential access, live data or WebSockets.
 */
import express from 'express';
import { requireWorkOSUser, type TokenVerifier } from '../auth/workos-auth.js';
import { createListOrganizationsRoute, type ListOrganizations } from '../auth/organization-route.js';
import { createAgentListRoute, type AgentListLoader } from './agent-list-route.js';
import { createHistoryRoute, type HistoryLoader } from './history-route.js';
import { denyPendingMonitoringApi } from '../legacy-transport.js';

export interface AgentPickerPreviewTestAdapters {
  readonly listOrganizations?: ListOrganizations;
  readonly listAgents?: AgentListLoader;
  readonly loadHistory?: HistoryLoader;
}

export function createAgentPickerHistoryPreviewApp(
  verifyToken: TokenVerifier,
  adapters: AgentPickerPreviewTestAdapters = {},
): ReturnType<typeof express> {
  if (typeof verifyToken !== 'function') throw new TypeError('WorkOS verification required');
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
  app.use('/api', requireWorkOSUser(verifyToken));
  app.get('/api/organizations', createListOrganizationsRoute(adapters.listOrganizations));
  app.get('/api/organizations/:organizationId/agents', createAgentListRoute(adapters.listAgents));
  app.get('/api/organizations/:organizationId/agents/:agentId/history', createHistoryRoute(adapters.loadHistory));
  app.use('/api', denyPendingMonitoringApi);
  return app;
}
