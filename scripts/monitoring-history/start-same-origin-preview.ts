/**
 * D15C-5P — explicit, localhost-only SAME-ORIGIN history dashboard preview.
 * Separate from server.ts and the D15C-5N API-only preview. Never deployed.
 */
import http from 'node:http';
import { createServer as createViteServer } from 'vite';
import {
  createWorkOSVerifier,
  readWorkOSAuthConfig,
} from '../../src/server/auth/workos-auth.js';
import { rejectUnauthenticatedUpgrade } from '../../src/server/legacy-transport.js';
import { createSameOriginHistoryPreviewApp } from '../../src/server/monitoring/same-origin-preview-app.js';
import { requireLocalHistoryPreview } from '../../src/server/monitoring/history-preview-policy.js';

const PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Pulse Metrics — Local Historical Preview</title>
  <meta name="robots" content="noindex,nofollow,noarchive" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/monitoring/history-preview-main.tsx"></script>
</body>
</html>`;

async function main(): Promise<void> {
  // No listener, Vite file service or DB pool before every explicit guard.
  if (process.argv.length !== 2 || process.env.PULSE_SAME_ORIGIN_PREVIEW !== 'enabled') {
    throw new Error('5P preview not explicitly enabled');
  }
  const settings = requireLocalHistoryPreview(process.env);
  // Verify live WorkOS configuration, never inject a test verifier in CLI.
  const verifier = createWorkOSVerifier(readWorkOSAuthConfig());
  const app = createSameOriginHistoryPreviewApp(verifier);

  const vite = await createViteServer({
    appType: 'custom',
    logLevel: 'error',
    server: {
      middlewareMode: true,
      hmr: false,
      fs: {
        strict: true,
        deny: ['**/.env*', '**/.git/**', '**/*.pem', '**/*.key', '**/*.crt'],
      },
    },
  });

  app.get('/history-preview', async (_req, res) => {
    try {
      const html = await vite.transformIndexHtml('/history-preview', PREVIEW_HTML);
      res.status(200).type('html').send(html);
    } catch {
      res.status(503).type('text').send('Local dashboard preview unavailable');
    }
  });
  // Vite serves development-only JS/CSS to this same localhost origin.
  app.use(vite.middlewares);
  app.use((_req, res) => res.status(404).end());

  const server = http.createServer(app);
  server.on('upgrade', rejectUnauthenticatedUpgrade);
  server.on('error', () => {
    console.error('[PulseMetrics] Local history dashboard preview unavailable');
    process.exitCode = 1;
    // Also release Vite's file watcher on port conflicts and bind failures.
    void vite.close().catch(() => { process.exitCode = 1; });
  });

  // If another server already occupies the port, fail: never auto-select
  // another port or fall back to an externally reachable address.
  server.listen(settings.port, settings.bindAddress, () => {
    console.log(`[PulseMetrics] D15C-5P local preview at http://${settings.bindAddress}:${settings.port}/history-preview`);
    console.log('[PulseMetrics] Historical reads only; not a live feed or production authorization');
  });

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await vite.close();
  }
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
}

void main().catch(() => {
  console.error('[PulseMetrics] D15C-5P preview refused or unavailable');
  process.exitCode = 1;
});
