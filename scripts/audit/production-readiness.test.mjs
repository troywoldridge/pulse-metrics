import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED, REVIEWED_COMMIT, scanSource } from './production-readiness.mjs';

const fixture = () => Object.fromEntries(REQUIRED.map(path => [path, '']));
function withEvidence() {
  const files = fixture();
  files['server.ts'] = `app.use('/api', requireWorkOSUser(createWorkOSVerifier(readWorkOSAuthConfig())));
app.post('/api/organizations', createCreateOrganizationRoute());
server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 403 Forbidden'); });
// startCollector();
if (msg.type === 'exec_ssh') { exec(fullCommand, { timeout: 8000 }, handler); }
const value = Math.random();
res.status(503).json({ error: 'organization_authorization_pending' });`;
  files['src/App.tsx'] = `import { SshTerminalDrawer } from './components/SshTerminalDrawer';
const ws = new WebSocket(wsUrl);`;
  files['src/server/historical-store.ts'] = 'const fabricated = Math.random();';
  files['src/agent/run-linux-agent.ts'] = `const state = { telemetryDestination: 'local_terminal_only' };`;
  files['src/main.tsx'] = 'const provider = AuthKitProvider;';
  files['src/server/auth/workos-auth.ts'] = 'workos.userManagement.verifyAccessToken(token);';
  files['docs/project/CURRENT-STATUS.md'] = 'WorkOS has not yet been integrated.';
  return files;
}
const byId = (data, id) => data.signals.find(x => x.id === id);

test('pinned reviewed Git commit is immutable in this audit version', () => {
  assert.equal(REVIEWED_COMMIT, 'f9095d6bcef8428ee877ca2892614146e753ff26');
});
test('launch decision never becomes GO from source-pattern success', () => {
  assert.equal(scanSource(withEvidence()).launchDecision, 'NO_GO');
});
test('source cannot silently skip missing security-relevant files', () => {
  const files = withEvidence(); delete files['server.ts'];
  assert.throws(() => scanSource(files), /required reviewed source unavailable/);
});
test('legacy SSH handler is identified', () => {
  assert.equal(byId(scanSource(withEvidence()), 'legacy-exec-handler').interpretation, 'BLOCKER');
});
test('shell invocation is independently identified', () => {
  assert.equal(byId(scanSource(withEvidence()), 'legacy-command-execution').observed, true);
});
test('rejected WebSocket upgrades are recognized as a current control', () => {
  assert.equal(byId(scanSource(withEvidence()), 'socket-upgrade-403').interpretation, 'CONTROL_OBSERVED');
});
test('removing an upgrade guard never implies that sockets are safe', () => {
  const files = withEvidence(); files['server.ts'] = files['server.ts'].replace('403 Forbidden', '101 Switching Protocols');
  assert.equal(byId(scanSource(files), 'socket-upgrade-403').interpretation, 'NOT_OBSERVED_REVIEW_REQUIRED');
});
test('simulated historical measurements are surfaced as blockers', () => {
  assert.equal(byId(scanSource(withEvidence()), 'fabricated-historical-store').interpretation, 'BLOCKER');
});
test('local-terminal-only agent is not mistaken for real ingestion', () => {
  assert.equal(byId(scanSource(withEvidence()), 'agent-output-terminal-only').interpretation, 'INTEGRATION_PENDING');
});
test('WorkOS code observation is not labeled independent production verification', () => {
  assert.equal(byId(scanSource(withEvidence()), 'jwt-verification').interpretation, 'FOUNDATION_OBSERVED');
});
test('stale handover text is surfaced explicitly', () => {
  assert.equal(byId(scanSource(withEvidence()), 'status-handover-stale').interpretation, 'DOCUMENTATION_DRIFT');
});
test('lack of a known string requires review, never an automatic green status', () => {
  const files = withEvidence(); files['src/App.tsx'] = 'export const Placeholder = true;';
  assert.equal(byId(scanSource(files), 'browser-ssh-interface').interpretation, 'NOT_OBSERVED_REVIEW_REQUIRED');
});
test('all emitted signals expose only source locations and explanations, no source bodies', () => {
  const report = scanSource(withEvidence());
  assert.equal(report.signals.length, 15);
  for (const s of report.signals) assert.deepEqual(Object.keys(s), ['id','file','observed','line','interpretation','description']);
});
