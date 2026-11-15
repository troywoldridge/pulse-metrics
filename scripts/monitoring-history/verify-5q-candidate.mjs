#!/usr/bin/env node
/** D15C-5Q pinned additive candidate and unchanged main monitoring hold. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED = Object.freeze({
  'README-D15C-5Q.md': '5085d7e91f618da2a3858ad28db6a0c91b6291afd8482bb74e8187802e6ad8b2',
  'scripts/monitoring-history/start-agent-picker-preview.ts': '0645f78c016a1c6eb8e5e717c6467f9681cc3073ae5557d456a123c3c2a313f8',
  'scripts/test-monitoring-agent-picker-preview.sh': '27c4ced3e758a013f321f858e1d84cc59917d5cb76bac202140542641563f3ea',
  'src/components/LocalAgentPickerPreview.tsx': 'f09b9f8a47fcca314dffaeb1262dd0f5900df817a6f82720233d91a6c8e504d3',
  'src/monitoring/agent-picker-preview-main.tsx': '4cc2235315e2d6734985a75bdce0b78fe422525d5576fb5139e8845db0019b6f',
  'src/monitoring/preview-agent-client.test.ts': '11f039ec0284b1793f9233dacd5e359afaad086bf1bf25ebd0786383da74829e',
  'src/monitoring/preview-agent-client.ts': '683b269cde94e662e18f606f06bc231a975aaeb8c844cd025331959fb82fac1d',
  'src/server/monitoring/agent-list-contract.test.ts': '21dad637377e5b41829a36aa15cd08f9d3e634e79a8f31d97c92387f59567187',
  'src/server/monitoring/agent-list-contract.ts': '0cb0803c1e1f2a50dbc133e04c24fd1ce9c6ef1c3c46d214d74c976b2f8712a0',
  'src/server/monitoring/agent-list-route.ts': 'fadc816ddfef791ed7273d1c632dfd1eb7f23d1f24809fc4580c6a6ff5534068',
  'src/server/monitoring/agent-list-service.ts': '34f93df741cfece10becc53932a628a4cc41ead2165f3f4254c7293c10123834',
  'src/server/monitoring/agent-picker-preview-app.test.ts': 'b52c0bf351d20094c9ea71365690a49fb24a19d11ff89f15243f3bed0965a949',
  'src/server/monitoring/agent-picker-preview-app.ts': 'bcaef894e3c792da8ef0fa9a00adf90153e5a19861b03f7ca1dfea7e637f66eb',
});
try {
  if (process.argv.length !== 2 || process.env.NODE_ENV === 'production') throw new Error('unsafe environment');
  for (const [path, hash] of Object.entries(EXPECTED)) {
    const full = resolve(ROOT, path);
    if (!lstatSync(full).isFile()) throw new Error('unsafe source');
    const bytes = readFileSync(full);
    if (bytes.includes(13) || bytes.toString('utf8').split('\n').some(line => /[ \t]+$/.test(line))) throw new Error('unsafe whitespace');
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('unreviewed source');
  }
  const server = readFileSync(resolve(ROOT, 'server.ts'), 'utf8');
  const main = readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8');
  const launcher = readFileSync(resolve(ROOT, 'scripts/monitoring-history/start-agent-picker-preview.ts'), 'utf8');
  const api = readFileSync(resolve(ROOT, 'src/server/monitoring/agent-picker-preview-app.ts'), 'utf8');
  if (!server.includes("app.use('/api', denyPendingMonitoringApi);") ||
      server.includes('createAgentPickerHistoryPreviewApp') ||
      main.includes('LocalAgentPickerPreview') ||
      !launcher.includes("process.env.PULSE_AGENT_PICKER_PREVIEW !== 'enabled'") ||
      !launcher.includes('requireLocalHistoryPreview(process.env)') ||
      !launcher.includes('createWorkOSVerifier(readWorkOSAuthConfig())') ||
      !launcher.includes("server.on('upgrade', rejectUnauthenticatedUpgrade)") ||
      !launcher.includes('server.listen(settings.port, settings.bindAddress') ||
      !api.includes("app.use('/api', requireWorkOSUser(verifyToken))") ||
      !api.includes("app.use('/api', denyPendingMonitoringApi)")) throw new Error('preview gate or monitoring hold modified');
  console.log('PASS: D15C-5Q agent picker hashes verified; main server and 5P hold unchanged');
  console.log('PUBLIC LAUNCH: NO_GO | read-only localhost candidate only');
} catch {
  console.error('REFUSE_D15C5Q_SOURCE: unreviewed or unsafe agent-discovery candidate');
  process.exitCode = 1;
}
