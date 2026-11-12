/**
 * Pulse Metrics — secure holding server after retiring the legacy monitor.
 *
 * Phase 2E3C5D6. This is NOT a production monitoring service.
 * All customer monitoring APIs fail closed until authenticated agent ingestion
 * and tenant-authorized live/historical reads are implemented and tested.
 * No SSH, shell execution, fabricated hosts or generated telemetry here.
 */
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkOSVerifier, readWorkOSAuthConfig, requireWorkOSUser } from './src/server/auth/workos-auth.js';
import { createIdentityRoute } from './src/server/auth/identity-route.js';
import {
  createCreateOrganizationRoute,
  createListOrganizationsRoute,
} from './src/server/auth/organization-route.js';
import { createMembershipRosterRoute } from './src/server/auth/organization-membership-route.js';
import { createInvitationIssuanceRoute } from './src/server/auth/invitation-issuance-route.js';
import { createLiveInvitationRateLimitGuards } from './src/server/security/invitation-rate-limit-middleware.js';
import {
  denyPendingMonitoringApi,
  rejectUnauthenticatedUpgrade,
} from './src/server/legacy-transport.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));

// Public liveness only. Never expose tenant data, host counts or identities.
app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

// Preserve the existing verified WorkOS + organization APIs and ordering.
// Pre-auth network limits, then verified identity, then post-auth actor limits.
const invitationRateLimits = createLiveInvitationRateLimitGuards();
app.post('/api/organizations/:organizationId/invitations', invitationRateLimits.network('issue'));
app.use('/api', requireWorkOSUser(createWorkOSVerifier(readWorkOSAuthConfig())));
app.get('/api/auth/me', createIdentityRoute());
app.get('/api/organizations', createListOrganizationsRoute());
app.post('/api/organizations', createCreateOrganizationRoute());
app.get('/api/organizations/:organizationId/members', createMembershipRosterRoute());
app.post(
  '/api/organizations/:organizationId/invitations',
  invitationRateLimits.actor('issue'),
  createInvitationIssuanceRoute(),
);

// No shared host list, metrics/history, machine enrollment or command API.
// Authentication runs before this response, and access is never implied.
app.use('/api', denyPendingMonitoringApi);

const server = http.createServer(app);

// No upgrade path is enabled until tickets, tenant-scoped subscriptions,
// per-event authorization and negative cross-organization tests exist.
server.on('upgrade', rejectUnauthenticatedUpgrade);

const filename = fileURLToPath(import.meta.url);
const root = path.dirname(filename);
const port = Number(process.env.PORT ?? '3000');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 through 65535');
}

async function startServer(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const dist = path.resolve(root, 'dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.resolve(dist, 'index.html')));
  }

  // Local-only for this prelaunch milestone. A future separately reviewed
  // reverse-proxy/TLS deployment must define and verify its network boundary.
  server.listen(port, '127.0.0.1', () => {
    console.log(`[PulseMetrics] Local-only API listening on 127.0.0.1:${port}`);
    console.log('[PulseMetrics] Monitoring ingestion, live views and WebSockets disabled');
  });
}

void startServer().catch(() => {
  // No internal configuration, credentials or paths in startup diagnostics.
  console.error('[PulseMetrics] Server startup failed; see local operator logs');
  process.exitCode = 1;
});
