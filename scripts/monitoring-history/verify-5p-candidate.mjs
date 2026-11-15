#!/usr/bin/env node
/** D15C-5P: pinned offline sources and main-monitoring hold guard. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'README-D15C-5P.md': 'f100244c017eabe5a5d6cf2a71f2641a0bd7dceefc8441429840ec881d0fdd6c',
  'scripts/monitoring-history/start-same-origin-preview.ts': '72cac2e5871f6c71c9ab172c0154766c96a55b5ea2c570dab5384e930ae06354',
  'scripts/test-monitoring-same-origin-preview.sh': '087a3b22c60cb33fbcd968e10912af72ebebad2e1b1bb35eb215f300798c7269',
  'src/components/LocalHistoryPreview.tsx': 'f47d092f05424f79e14a410f5cdab4bbbaf46596e7847ffa6fb47f01bb69c251',
  'src/monitoring/history-preview-main.tsx': '33d9580aeb5de60e1a76745a2f214d9a44c126d7e1c90b7b480c91094702f465',
  'src/monitoring/preview-organization-client.test.ts': '03dddbafc015aa72b7d2ad046280ba8cb4e5917a5c6cb25fa49c722fbbde1d01',
  'src/monitoring/preview-organization-client.ts': '365f7054952a201d1f9c142d0f4d2f356616e26d69196ec40ce7238bedda2208',
  'src/server/monitoring/same-origin-preview-app.test.ts': 'e8b164c309089fd9234aa2a1d50cd25bc19a2af7d407eb52b8f8d5412729d630',
  'src/server/monitoring/same-origin-preview-app.ts': '3873cbe93b61cdaf484188c1658f03962ce966fa2394ed744a4c67e0d97d7f4e',
});

function source(path) {
  const absolute = resolve(ROOT, path);
  if (!lstatSync(absolute).isFile()) throw new Error('unsafe_source_type');
  const bytes = readFileSync(absolute);
  if (bytes.includes(13) || bytes.toString('utf8').split('\n').some(line => /[ \t]+$/.test(line))) {
    throw new Error('whitespace_or_crlf');
  }
  return bytes;
}

try {
  if (process.argv.length !== 2 || process.env.NODE_ENV === 'production') {
    throw new Error('invalid_environment');
  }
  for (const [path, expected] of Object.entries(EXPECTED)) {
    const digest = createHash('sha256').update(source(path)).digest('hex');
    if (digest !== expected) throw new Error('source_mismatch');
  }
  const server = readFileSync(resolve(ROOT, 'server.ts'), 'utf8');
  const main = readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8');
  const boundary = readFileSync(resolve(ROOT, 'src/components/AuthenticatedBoundary.tsx'), 'utf8');
  const cli = readFileSync(resolve(ROOT, 'scripts/monitoring-history/start-same-origin-preview.ts'), 'utf8');
  const api = readFileSync(resolve(ROOT, 'src/server/monitoring/same-origin-preview-app.ts'), 'utf8');
  if (!server.includes("app.use('/api', denyPendingMonitoringApi);") ||
      server.includes('createSameOriginHistoryPreviewApp') ||
      server.includes('createHistoryRoute(') ||
      main.includes('LocalHistoryPreview') ||
      boundary.includes('LocalHistoryPreview') ||
      !cli.includes("process.env.PULSE_SAME_ORIGIN_PREVIEW !== 'enabled'") ||
      !cli.includes('requireLocalHistoryPreview(process.env)') ||
      !cli.includes('createWorkOSVerifier(readWorkOSAuthConfig())') ||
      !cli.includes("server.on('upgrade', rejectUnauthenticatedUpgrade)") ||
      !cli.includes('server.listen(settings.port, settings.bindAddress') ||
      !api.includes("app.use('/api', requireWorkOSUser(verifier))") ||
      !api.includes("app.use('/api', denyPendingMonitoringApi)")) {
    throw new Error('main_hold_or_preview_gate_modified');
  }
  console.log('PASS: D15C-5P reviewed source SHA-256 and 5L–5O monitoring holds intact');
  console.log('PUBLIC LAUNCH: NO_GO | local same-origin browser candidate only');
} catch {
  console.error('REFUSE_D15C5P_SOURCE: unreviewed source or unsafe preview integration');
  process.exitCode = 1;
}
