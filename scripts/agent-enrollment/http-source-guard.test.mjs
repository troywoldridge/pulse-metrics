import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE, PROTECTED, ADDED, checkContract } from './http-source-guard.mjs';

const service = `const x = createEnrollmentMaterial(); const y = createAgentSecretMaterial(); const z=hashAgentSecret('x');
  async issue(){}; async redeem(){};`;
const routes = `createIssueAgentEnrollmentRoute(service: AgentEnrollmentService)
  createRedeemAgentEnrollmentRoute(service: AgentEnrollmentService)
  isVerifiedActor(identity); agentEnrollmentIngressVerified; res.status(401); res.status(403); res.status(404); res.status(503);
  res.setHeader('Cache-Control', 'no-store');`;
const integration = `pulse_agent_rehearsal.issue_enrollment() pulse_agent_rehearsal.redeem_enrollment()
  Promise.all([]); [201, 404]`;
function fixture() {
  return {
    'src/server/agent-enrollment-service.ts': service,
    'src/server/agent-enrollment-routes.ts': routes,
    'scripts/agent-enrollment/http-integration.ts': integration,
    'server.ts': `app.use('/api', requireWorkOSUser());`,
    'src/main.tsx': 'AuthenticatedBoundary',
  };
}
const failed = s => checkContract(s).filter(x=>!x.passed).map(x=>x.file);

test('source pin remains locked to reviewed D7 commit', () => {
  assert.equal(BASELINE, '89e86acc409a44c75671de2cfb29c4e6b0159ac0');
  assert.equal(Object.keys(PROTECTED).length, 7);
  assert.equal(ADDED.length, 8);
});
test('expected unmounted HTTP foundation shape passes', () => assert.equal(failed(fixture()).length,0));
test('missing server is never considered safe', () => { const f=fixture(); delete f['server.ts']; assert.ok(failed(f).includes('server.ts')); });
test('missing service cannot pass', () => { const f=fixture(); delete f['src/server/agent-enrollment-service.ts']; assert.ok(failed(f).includes('src/server/agent-enrollment-service.ts')); });
test('a new public route mount must fail', () => { const f=fixture(); f['server.ts'] += '\napp.post("/api/agent-enrollments/redeem", createRedeemAgentEnrollmentRoute(service));'; assert.ok(failed(f).includes('server.ts')); });
test('dropping verification guard fails', () => { const f=fixture(); f['src/server/agent-enrollment-routes.ts']=f['src/server/agent-enrollment-routes.ts'].replace('isVerifiedActor(identity)','true'); assert.ok(failed(f).includes('src/server/agent-enrollment-routes.ts')); });
test('dropping no-store fails', () => { const f=fixture(); f['src/server/agent-enrollment-routes.ts']=f['src/server/agent-enrollment-routes.ts'].replace("'Cache-Control', 'no-store'", "'Cache-Control', 'public'"); assert.ok(failed(f).includes('src/server/agent-enrollment-routes.ts')); });
test('dropping concurrency rehearsal fails', () => { const f=fixture(); f['scripts/agent-enrollment/http-integration.ts']=f['scripts/agent-enrollment/http-integration.ts'].replace('Promise.all([])','[]'); assert.ok(failed(f).includes('scripts/agent-enrollment/http-integration.ts')); });
test('browser entrypoint change cannot be ignored', () => { const f=fixture(); f['src/main.tsx']='App'; assert.ok(failed(f).includes('src/main.tsx')); });

test('dropping explicit verified ingress gate fails', () => {
  const f=fixture();
  f['src/server/agent-enrollment-routes.ts']=f['src/server/agent-enrollment-routes.ts'].replace('agentEnrollmentIngressVerified','true');
  assert.ok(failed(f).includes('src/server/agent-enrollment-routes.ts'));
});
