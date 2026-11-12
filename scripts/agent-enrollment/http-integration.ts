/**
 * Phase 2E3C5D8: REAL HTTP -> service -> PostgreSQL rehearsal on disposable
 * Unix-only cluster, AFTER the existing Phase 2E3C5D7 rehearsal has passed.
 * The real server.ts remains unchanged; these HTTP routes are NEVER mounted.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import http from 'node:http';
import express from 'express';
import pg from 'pg';
import {
  createAgentEnrollmentService,
  EnrollmentNotAvailable,
  EnrollmentPermissionDenied,
  type EnrollmentGateway,
} from '../../src/server/agent-enrollment-service.js';
import {
  createIssueAgentEnrollmentRoute,
  createRedeemAgentEnrollmentRoute,
} from '../../src/server/agent-enrollment-routes.js';
import { hashAgentSecret } from '../../src/server/agent-credential-policy.js';

const { Pool } = pg;
const SOCKET = process.env.PULSE_AGENT_SOCKET;
const DATA = process.env.PULSE_AGENT_DATA;
const ORG_A = process.env.PULSE_AGENT_ORG_A;
const ORG_B = process.env.PULSE_AGENT_ORG_B;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function insist(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error('REFUSE_D8_HTTP_REHEARSAL: ' + reason);
}
function guard(): void {
  insist(process.env.PULSE_AGENT_DISPOSABLE_ONLY === 'YES', 'disposable-only authorization missing');
  insist(process.env.NODE_ENV !== 'production', 'production mode not allowed');
  insist(typeof SOCKET === 'string' && /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/.test(SOCKET), 'unexpected socket path');
  insist(DATA === `${dirname(SOCKET)}/data`, 'data directory mismatch');
  const marker = `${dirname(SOCKET)}/.pulse-agent-enrollment-marker`;
  insist(existsSync(marker) && lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink(), 'missing isolated marker');
  insist(typeof ORG_A === 'string' && UUID.test(ORG_A), 'invalid synthetic org A');
  insist(typeof ORG_B === 'string' && UUID.test(ORG_B) && ORG_B !== ORG_A, 'invalid synthetic org B');
}

const agentDescription = {
  displayName: 'HTTP Rehearsal Linux Agent',
  hostname: 'http-rehearsal.invalid',
  platform: 'linux',
  architecture: 'x86_64',
};

async function main() {
  guard();
  const pool = new Pool({ host: SOCKET, port: 55432, database: 'pulse_metrics',
    user: 'pulse_metrics_app', ssl: false, max: 5, connectionTimeoutMillis: 3000,
    statement_timeout: 8000 });
  let server: http.Server | null = null;
  try {
    const identity = await pool.query(`SELECT current_database() AS db, current_user AS role,
      inet_server_addr() IS NULL AS socket_only`);
    insist(identity.rows[0]?.db === 'pulse_metrics' &&
      identity.rows[0]?.role === 'pulse_metrics_app' &&
      identity.rows[0]?.socket_only === true, 'unverified restricted application connection');

    const gateway: EnrollmentGateway = {
      async issue(record) {
        try {
          const response = await pool.query(`
            SELECT pulse_agent_rehearsal.issue_enrollment($1,$2::uuid,$3,$4,$5,$6::timestamptz) AS enrollment_id`,
          [record.subject, record.organizationId, record.tokenHash, record.tokenPrefix,
            record.label, record.expiresAt]);
          return response.rows[0]?.enrollment_id;
        } catch (error) {
          if ((error as { code?: string }).code === '42501') throw new EnrollmentPermissionDenied();
          throw error;
        }
      },
      async redeem(record) {
        try {
          const response = await pool.query(`
            SELECT organization_id, agent_id
            FROM pulse_agent_rehearsal.redeem_enrollment($1,$2,$3,$4,$5,$6,$7)`,
          [record.enrollmentHash, record.credentialHash, record.credentialPrefix,
            record.agent.displayName, record.agent.hostname,
            record.agent.platform, record.agent.architecture]);
          return response.rows[0] ? {
            organizationId: response.rows[0].organization_id,
            agentId: response.rows[0].agent_id,
          } : null;
        } catch (error) {
          if ((error as { code?: string }).code === 'P0002') throw new EnrollmentNotAvailable();
          throw error;
        }
      },
    };

    const service = createAgentEnrollmentService(gateway);
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2kb' }));
    // Test-only admission marker. NEVER set this header-driven in production.
    app.use((_req, res, next) => {
      res.locals.agentEnrollmentIngressVerified = true;
      next();
    });
    // Synthetic trusted identities. ONLY within this loopback disposable test.
    // A deployed server must use real WorkOS verifier + network rate limits.
    app.post('/test/organizations/:organizationId/enrollments', (req, res, next) => {
      const synthetic = req.headers['x-test-actor'];
      if (typeof synthetic === 'string' &&
          ['user_agent_owner_a', 'user_agent_owner_b', 'user_agent_viewer_a'].includes(synthetic)) {
        res.locals.authenticatedIdentity = { provider: 'workos', subject: synthetic, sessionId: 'test-only' };
      }
      next();
    }, createIssueAgentEnrollmentRoute(service));
    app.post('/test/redeem', createRedeemAgentEnrollmentRoute(service));
    server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    insist(addr && typeof addr !== 'string', 'missing loopback test address');
    const url = `http://127.0.0.1:${addr.port}`;
    async function issue(org: string, actor: string | null, body: unknown) {
      return fetch(`${url}/test/organizations/${org}/enrollments`, {
        method: 'POST', headers: {
          'Content-Type': 'application/json', ...(actor ? { 'x-test-actor': actor } : {}),
        }, body: JSON.stringify(body),
      });
    }
    async function redeem(body: unknown) {
      return fetch(`${url}/test/redeem`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }

    assert.equal((await issue(ORG_A!, null, { label: 'Test' })).status, 401);
    assert.equal((await issue(ORG_A!, 'user_agent_viewer_a', { label: 'Test' })).status, 403);
    assert.equal((await issue(ORG_B!, 'user_agent_owner_a', { label: 'Test' })).status, 403);
    assert.equal((await issue(ORG_A!, 'user_agent_owner_a', { label: 'Test', role: 'owner' })).status, 400);
    console.log('PASS: HTTP issue requires verified actor shape, valid body and correct tenant role');

    const issued = await issue(ORG_A!, 'user_agent_owner_a', { label: '  Test HTTP enrollment  ' });
    assert.equal(issued.status, 201);
    assert.equal(issued.headers.get('cache-control'), 'no-store');
    const ticket = await issued.json() as { oneTimeToken: string; organizationId: string; enrollmentId: string; expiresAt: string };
    assert.equal(ticket.organizationId, ORG_A);
    insist(UUID.test(ticket.enrollmentId), 'invalid enrollment ID');
    assert.equal(hashAgentSecret(ticket.oneTimeToken).length, 64);
    console.log('PASS: verified tenant owner receives only one-time enrollment secret');

    assert.equal((await redeem({ token: ticket.oneTimeToken, agent: { ...agentDescription, organizationId: ORG_B } })).status, 400);
    const parallel = await Promise.all([
      redeem({ token: ticket.oneTimeToken, agent: agentDescription }),
      redeem({ token: ticket.oneTimeToken, agent: agentDescription }),
    ]);
    assert.deepEqual(parallel.map(r => r.status).sort(), [201, 404]);
    const success = parallel.find(r => r.status === 201)!;
    assert.equal(success.headers.get('cache-control'), 'no-store');
    const machine = await success.json() as { organizationId: string; agentId: string; machineCredential: string };
    assert.equal(machine.organizationId, ORG_A);
    insist(UUID.test(machine.agentId), 'invalid machine agent UUID');
    assert.notEqual(machine.machineCredential, ticket.oneTimeToken);
    const replay = await redeem({ token: ticket.oneTimeToken, agent: agentDescription });
    assert.equal(replay.status, 404);
    console.log('PASS: two parallel HTTP redeemers yield exactly one credential; replay refused');

    // The real database verification method checks the credential against the
    // linked agent's revocation state without consulting browser-owned IDs.
    const credentialHash = hashAgentSecret(machine.machineCredential);
    const verified = await pool.query(`SELECT organization_id,agent_id
      FROM pulse_agent_rehearsal.verify_credential($1)`, [credentialHash]);
    assert.equal(verified.rows.length, 1);
    assert.equal(verified.rows[0].organization_id, ORG_A);
    assert.equal(verified.rows[0].agent_id, machine.agentId);
    await pool.query(`SELECT pulse_agent_rehearsal.revoke_agent($1,$2::uuid,$3::uuid)`,
      ['user_agent_owner_a', ORG_A, machine.agentId]);
    const revoked = await pool.query(`SELECT organization_id,agent_id
      FROM pulse_agent_rehearsal.verify_credential($1)`, [credentialHash]);
    assert.equal(revoked.rows.length, 0);
    console.log('PASS: one-time machine credential is tenant-bound and denied after revocation');

    const count = await pool.query(`SELECT 1 FROM public.agent_credentials LIMIT 1`).then(
      () => 'unsafe', () => 'denied');
    assert.equal(count, 'denied');
    console.log('PASS: ordinary application role still cannot directly inspect credential table');
    console.log('PASS: disposable HTTP-to-PostgreSQL enrollment rehearsal complete; public server still UNMOUNTED');
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await pool.end();
  }
}

main().catch(error => {
  // Tests use synthetic values only; avoid printing token/header or SQL details.
  console.error('D8 HTTP/DB REHEARSAL FAILED:', error instanceof Error ? error.message : 'unknown');
  process.exitCode = 1;
});
