/**
 * D15C-5N — explicit, local-only read-only history preview.
 *
 * Run solely on adap with NODE_ENV=development and
 * PULSE_HISTORY_PREVIEW=read-only; never as a production service.
 * The main Pulse Metrics server is untouched.
 */
import http from 'node:http';
import {
  createWorkOSVerifier,
  readWorkOSAuthConfig,
} from '../../src/server/auth/workos-auth.js';
import { rejectUnauthenticatedUpgrade } from '../../src/server/legacy-transport.js';
import { createLocalHistoryPreviewApp } from '../../src/server/monitoring/history-preview-app.js';
import { requireLocalHistoryPreview } from '../../src/server/monitoring/history-preview-policy.js';

async function main(): Promise<void> {
  // Reject unsafe activation before creating a listener or database pool.
  if (process.argv.length !== 2) throw new Error('Unexpected CLI arguments');
  const settings = requireLocalHistoryPreview(process.env);
  const verifier = createWorkOSVerifier(readWorkOSAuthConfig());
  const app = createLocalHistoryPreviewApp(verifier);
  const server = http.createServer(app);
  server.on('upgrade', rejectUnauthenticatedUpgrade);
  server.on('error', () => {
    console.error('[PulseMetrics] Local history preview unavailable');
    process.exitCode = 1;
  });
  server.listen(settings.port, settings.bindAddress, () => {
    console.log(`[PulseMetrics] LOCAL READ-ONLY history preview listening on ${settings.bindAddress}:${settings.port}`);
    console.log('[PulseMetrics] Not production approved; main monitoring APIs remain disabled');
  });
}

void main().catch(() => {
  // Do not dump DATABASE_URL, JWTs, SQL diagnostics or provider secrets.
  console.error('[PulseMetrics] D15C-5N local preview refused or unavailable');
  process.exitCode = 1;
});
