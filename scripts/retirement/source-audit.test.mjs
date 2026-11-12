import assert from 'node:assert/strict';
import test from 'node:test';
import { audit, REQUIRED, RETIRED } from './source-audit.mjs';

const fixture = () => ({
  sources: Object.fromEntries(REQUIRED.map(file => [file, ''])),
  retired: Object.fromEntries(RETIRED.map(file => [file, false])),
});

function passing() {
  const f = fixture();
  f.sources['server.ts'] = `app.use('/api', requireWorkOSUser(createWorkOSVerifier(readWorkOSAuthConfig())));
app.get('/api/auth/me', createIdentityRoute());
app.get('/api/organizations', createListOrganizationsRoute());
app.post('/api/organizations', createCreateOrganizationRoute());
app.get('/api/organizations/:organizationId/members', createMembershipRosterRoute());
app.post('/api/organizations/:organizationId/invitations', invitationRateLimits.actor('issue'), createInvitationIssuanceRoute());
app.post('/api/organizations/:organizationId/invitations', invitationRateLimits.network('issue'));
app.use('/api', denyPendingMonitoringApi);
server.on('upgrade', rejectUnauthenticatedUpgrade);
server.listen(port, '127.0.0.1');`;
  f.sources['src/server/legacy-transport.ts'] = `res.status(503).json({ error: 'organization_authorization_pending' });
socket.end('HTTP/1.1 403 Forbidden');`;
  f.sources['src/main.tsx'] = 'AuthKitProvider AuthenticatedBoundary';
  f.sources['src/components/AuthenticatedBoundary.tsx'] = "getAccessToken fetch('/api/organizations')";
  f.sources['src/App.tsx'] = 'Measurements are unavailable. Monitoring not enabled.';
  f.sources['src/agent/run-linux-agent.ts'] = 'LinuxTelemetryCollector telemetryDestination: local_terminal_only';
  f.sources['src/agent/linux-collector.ts'] = 'readFile /proc/stat';
  return f;
}

test('safe holding-state source fixture passes all 13 independent guards', () => {
  const { sources, retired } = passing();
  const r = audit(sources, retired);
  assert.equal(r.passed, 13);
  assert.equal(r.total, 13);
  assert.equal(r.publicLaunch, 'NO_GO');
});

test('missing source cannot be called safe', () => {
  const { sources, retired } = passing();
  delete sources['server.ts'];
  assert.throws(() => audit(sources, retired), /missing reviewed file/);
});

test('missing removal evidence cannot be called safe', () => {
  const { sources, retired } = passing();
  delete retired['src/server/historical-store.ts'];
  assert.throws(() => audit(sources, retired), /missing file-existence proof/);
});

const regressions = [
  ['no-server-shell-or-ssh', f => { f.sources['server.ts'] += " exec('uname -a');"; }],
  ['no-generated-server-metrics', f => { f.sources['server.ts'] += ' Math.random();'; }],
  ['workos-auth-mounted', f => { f.sources['server.ts'] = f.sources['server.ts'].replace('requireWorkOSUser', 'noGuard'); }],
  ['organization-routes-preserved', f => { f.sources['server.ts'] = f.sources['server.ts'].replace('createMembershipRosterRoute()', 'missingRoster'); }],
  ['deny-unimplemented-api', f => { f.sources['server.ts'] = f.sources['server.ts'].replace('denyPendingMonitoringApi', 'unsafeMonitoring'); }],
  ['deny-websocket-upgrade', f => { f.sources['src/server/legacy-transport.ts'] = 'socket.end("HTTP/1.1 101 Switching Protocols");'; }],
  ['local-only-bind', f => { f.sources['server.ts'] = f.sources['server.ts'].replace("'127.0.0.1'", "'0.0.0.0'"); }],
  ['browser-auth-boundary', f => { f.sources['src/main.tsx'] = 'AnonymousApp'; }],
  ['no-browser-ssh-or-mock-ws', f => { f.sources['src/App.tsx'] += ' new WebSocket(wsUrl);'; }],
  ['honest-unavailable-state', f => { f.sources['src/App.tsx'] = 'Live dashboards all green'; }],
  ['agent-not-repurposed', f => { f.sources['src/agent/run-linux-agent.ts'] = 'fake sample'; }],
  ['old-history-source-deleted', f => { f.retired['src/server/historical-store.ts'] = true; }],
  ['old-ssh-drawers-deleted', f => { f.retired['src/components/SshTerminalDrawer.tsx'] = true; }],
];
for (const [id, mutate] of regressions) {
  test(`detects ${id} regression`, () => {
    const f = passing();
    mutate(f);
    const check = audit(f.sources, f.retired).checks.find(row => row.id === id);
    assert.equal(check?.pass, false);
  });
}
