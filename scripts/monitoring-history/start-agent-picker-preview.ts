/**
 * D15C-5Q — localhost-only verified WorkOS agent-picker history preview.
 * Replaces 5P's local port during manual review, without modifying 5P or server.ts.
 */
import http from 'node:http';
import { createServer as createViteServer } from 'vite';
import { createWorkOSVerifier, readWorkOSAuthConfig } from '../../src/server/auth/workos-auth.js';
import { rejectUnauthenticatedUpgrade } from '../../src/server/legacy-transport.js';
import { requireLocalHistoryPreview } from '../../src/server/monitoring/history-preview-policy.js';
import { createAgentPickerHistoryPreviewApp } from '../../src/server/monitoring/agent-picker-preview-app.js';

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow,noarchive" />
<title>Pulse Metrics — Local Agent Picker Preview</title>
</head><body><div id="root"></div>
<script type="module" src="/src/monitoring/agent-picker-preview-main.tsx"></script>
</body></html>`;

async function main(): Promise<void> {
  if (process.argv.length !== 2 ||
      process.env.PULSE_AGENT_PICKER_PREVIEW !== 'enabled' ||
      process.env.PULSE_SAME_ORIGIN_PREVIEW !== 'enabled') {
    throw new Error('Explicit local preview opt-in missing');
  }
  const settings = requireLocalHistoryPreview(process.env);
  const verifier = createWorkOSVerifier(readWorkOSAuthConfig());
  const app = createAgentPickerHistoryPreviewApp(verifier);
  const vite = await createViteServer({
    appType: 'custom', logLevel: 'error',
    server: {
      middlewareMode: true, hmr: false,
      fs: { strict: true, deny: ['**/.env*', '**/.git/**', '**/*.pem', '**/*.key', '**/*.crt'] },
    },
  });
  app.get('/history-preview', async (_req, res) => {
    try { res.status(200).type('html').send(await vite.transformIndexHtml('/history-preview', HTML)); }
    catch { res.status(503).type('text').send('Local preview unavailable'); }
  });
  app.use(vite.middlewares);
  app.use((_req, res) => res.status(404).end());
  const server = http.createServer(app);
  server.on('upgrade', rejectUnauthenticatedUpgrade);
  server.on('error', () => {
    console.error('[PulseMetrics] D15C-5Q local preview port unavailable');
    process.exitCode = 1;
    void vite.close().catch(() => { process.exitCode = 1; });
  });
  server.listen(settings.port, settings.bindAddress, () => {
    console.log(`[PulseMetrics] D15C-5Q local agent picker at http://${settings.bindAddress}:${settings.port}/history-preview`);
    console.log('[PulseMetrics] Verified tenant agents and stored history only; NO public or live monitoring');
  });
  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await vite.close();
  }
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
}

void main().catch(() => {
  console.error('[PulseMetrics] D15C-5Q preview refused or unavailable');
  process.exitCode = 1;
});
