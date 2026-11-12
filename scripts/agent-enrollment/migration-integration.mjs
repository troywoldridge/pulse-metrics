/**
 * Phase 2E3C5D9 — versioned candidate machine-identity lifecycle integration rehearsal.
 * Never connects to DATABASE_URL, never logs raw tokens, never touches real data.
 * Verified WorkOS identities here are synthetic fixture subjects, NOT real JWTs.
 */
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const { Client } = pg;
const SOCKET = process.env.PULSE_AGENT_SOCKET;
const DATA = process.env.PULSE_AGENT_DATA;
const PORT = 55432;
const ORG_A = process.env.PULSE_AGENT_ORG_A;
const ORG_B = process.env.PULSE_AGENT_ORG_B;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function insist(value, message) {
  if (!value) throw Error(`REFUSE_AGENT_REHEARSAL: ${message}`);
}
function guard() {
  insist(process.env.PULSE_AGENT_DISPOSABLE_ONLY === 'YES' && process.env.NODE_ENV !== 'production',
    'requires explicit non-production isolated test mode');
  insist(typeof SOCKET === 'string' && /^\/tmp\/pulse-replay-[A-Za-z0-9]{10}\/socket$/.test(SOCKET) &&
    DATA === `${dirname(SOCKET)}/data`, 'refusing any unrecognized cluster path');
  const marker = `${dirname(SOCKET)}/.pulse-agent-enrollment-marker`;
  insist(existsSync(marker) && lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink(),
    'isolated PostgreSQL marker is missing');
  insist(UUID.test(ORG_A ?? '') && UUID.test(ORG_B ?? '') && ORG_A !== ORG_B,
    'two distinct fixture organizations are required');
}
function freshSecret() {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  return { raw, hash, prefix: hash.slice(0, 12) };
}
async function open() {
  guard();
  const client = new Client({ host: SOCKET, port: PORT, user: 'pulse_metrics_app',
    database: 'pulse_metrics', password: undefined, ssl: false,
    connectionTimeoutMillis: 2500, statement_timeout: 6000,
    application_name: 'pulse-synthetic-agent-test' });
  await client.connect();
  const check = await client.query(`SELECT current_database() AS db, current_user AS role,
    session_user AS session_role, inet_server_addr() IS NULL AS local_socket,
    inet_server_port() IS NULL AS no_tcp`);
  const row = check.rows[0];
  insist(check.rowCount === 1 && row.db === 'pulse_metrics' &&
    row.role === 'pulse_metrics_app' && row.session_role === 'pulse_metrics_app' &&
    row.local_socket && row.no_tcp, 'untrusted PostgreSQL connection');
  return client;
}

async function sql(client, name, params = []) {
  return client.query(`SELECT * FROM pulse_agent_enrollment.${name}`, params);
}
async function issue(client, subject, org, material, label = 'Synthetic Linux enrollment') {
  return sql(client, 'issue_enrollment($1::text,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz)',
    [subject, org, material.hash, material.prefix, label, new Date(Date.now() + 10 * 60000).toISOString()]);
}
async function redeem(client, token, credential, suffix) {
  return sql(client, 'redeem_enrollment($1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text)',
    [token.hash, credential.hash, credential.prefix, `Synthetic Agent ${suffix}`, `synthetic-${suffix}.invalid`, 'linux', 'x86_64']);
}
async function verify(client, credential) {
  const r = await sql(client, 'verify_credential($1::text)', [credential.hash]);
  return r.rows;
}
async function rotate(client, who, org, agent, credential) {
  return sql(client, 'rotate_credential($1::text,$2::uuid,$3::uuid,$4::text,$5::text)',
    [who, org, agent, credential.hash, credential.prefix]);
}
async function revoke(client, who, org, agent) {
  return sql(client, 'revoke_agent($1::text,$2::uuid,$3::uuid)', [who, org, agent]);
}
async function denied(task, code, label) {
  let failed = false;
  try { await task(); } catch (e) {
    failed = true;
    insist(e.code === code, `${label}: wrong SQLSTATE ${String(e.code)}`);
  }
  insist(failed, `${label}: unsafe operation unexpectedly succeeded`);
}
async function main() {
  guard();
  // No tables, identities or tokens outside this disposable cluster.
  const a = await open();
  let b;
  let c;
  try {
    for (const query of [
      'SELECT * FROM public.agent_credentials',
      'SELECT * FROM public.agent_enrollment_tokens',
      'INSERT INTO public.agent_credentials (organization_id,agent_id,token_prefix,token_hash) VALUES (gen_random_uuid(),gen_random_uuid(),\'foo\',repeat(\'a\',64))',
      'UPDATE public.monitored_agents SET status=\'active\'',
    ]) await denied(() => a.query(query), '42501', 'direct table access');
    console.log('PASS: runtime cannot directly inspect or mutate enrollment/credential tables');

    const issuedA = freshSecret();
    await denied(() => issue(a, 'user_agent_viewer_a', ORG_A, issuedA), '42501', 'viewer issue');
    await denied(() => issue(a, 'user_agent_owner_b', ORG_A, issuedA), '42501', 'foreign-owner issue');
    await denied(() => issue(a, 'user_agent_missing', ORG_A, issuedA), '42501', 'unknown actor issue');
    await denied(() => sql(a, 'issue_enrollment($1,$2::uuid,$3,$4,$5,$6::timestamptz)',
      ['user_agent_owner_a', ORG_A, issuedA.hash, issuedA.prefix, 'bad', new Date(Date.now()-60000).toISOString()]),
    '22023', 'expired issue');
    const issueA = await issue(a, 'user_agent_owner_a', ORG_A, issuedA);
    insist(UUID.test(issueA.rows[0]?.issue_enrollment ?? ''), 'authorized issue did not return token ID');
    console.log('PASS: only owner/admin of the correct organization may issue 10-minute single-use enrollment');

    const credentialA = freshSecret();
    await denied(() => redeem(a, freshSecret(), credentialA, 'wrong-token'), 'P0002', 'unknown enrollment');
    await denied(() => redeem(a, { hash: 'e'.repeat(64) }, freshSecret(), 'expired-token'), 'P0002', 'expired enrollment');
    await denied(() => redeem(a, { hash: 'd'.repeat(64) }, freshSecret(), 'revoked-token'), 'P0002', 'revoked enrollment');
    const redeemedA = await redeem(a, issuedA, credentialA, 'A');
    const agentA = redeemedA.rows[0]?.agent_id;
    insist(UUID.test(agentA ?? '') && redeemedA.rows[0].organization_id === ORG_A,
      'enrollment was not bound to correct organization');
    await denied(() => redeem(a, issuedA, freshSecret(), 'replay'), 'P0002', 'replayed enrollment');
    insist((await verify(a, credentialA)).length === 1, 'fresh agent credential not accepted');
    insist((await verify(a, freshSecret())).length === 0, 'unknown credential was accepted');
    console.log('PASS: one-time redemption creates organization-bound agent and distinct hashed machine credential');

    // Two separate database sessions attempt the SAME unconsumed enrollment.
    const raceToken = freshSecret();
    await issue(a, 'user_agent_owner_a', ORG_A, raceToken);
    b = await open();
    c = await open();
    const raceCred1 = freshSecret();
    const raceCred2 = freshSecret();
    const outcomes = await Promise.allSettled([
      redeem(b, raceToken, raceCred1, 'race-one'),
      redeem(c, raceToken, raceCred2, 'race-two'),
    ]);
    const winners = outcomes.filter(v => v.status === 'fulfilled');
    const losers = outcomes.filter(v => v.status === 'rejected');
    insist(winners.length === 1 && losers.length === 1 && losers[0].reason?.code === 'P0002',
      'simultaneous enrollment did not serialize exactly once');
    const winnerOrg = winners[0].value.rows[0].organization_id;
    insist(winnerOrg === ORG_A, 'parallel redemption crossed organization boundary');
    const activeRaceCredentials = (await verify(a, raceCred1)).length + (await verify(a, raceCred2)).length;
    insist(activeRaceCredentials === 1, 'concurrent redemption created multiple active credentials');
    console.log('PASS: TWO independent sessions raced a single enrollment; exactly one succeeded');

    await denied(() => rotate(a, 'user_agent_owner_b', ORG_A, agentA, freshSecret()), '42501', 'cross-org rotate');
    await denied(() => rotate(a, 'user_agent_viewer_a', ORG_A, agentA, freshSecret()), '42501', 'viewer rotate');
    const rotated = freshSecret();
    const rotatedResult = await rotate(a, 'user_agent_owner_a', ORG_A, agentA, rotated);
    insist(rotatedResult.rows[0]?.rotate_credential === true, 'rotation rejected correct owner');
    insist((await verify(a, credentialA)).length === 0, 'old credential survived rotation');
    insist((await verify(a, rotated)).length === 1, 'rotated credential missing');
    console.log('PASS: owner-only rotation invalidates prior credential and preserves organization binding');

    await denied(() => revoke(a, 'user_agent_owner_b', ORG_A, agentA), '42501', 'foreign revoke');
    await denied(() => revoke(a, 'user_agent_viewer_a', ORG_A, agentA), '42501', 'viewer revoke');
    const revoked = await revoke(a, 'user_agent_owner_a', ORG_A, agentA);
    insist(revoked.rows[0]?.revoke_agent === true, 'owner could not revoke');
    insist((await verify(a, rotated)).length === 0, 'revoked credential was still accepted');
    const again = await revoke(a, 'user_agent_owner_a', ORG_A, agentA);
    insist(again.rows[0]?.revoke_agent === false, 'repeat revocation was not idempotent');
    await denied(() => rotate(a, 'user_agent_owner_a', ORG_A, agentA, freshSecret()), 'P0002', 'revoked rotate');
    console.log('PASS: revocation is tenant-authorized, idempotent and prevents future authentication');

    const tokenB = freshSecret();
    await issue(a, 'user_agent_owner_b', ORG_B, tokenB);
    const credentialB = freshSecret();
    const enrolledB = await redeem(a, tokenB, credentialB, 'B');
    insist(enrolledB.rows[0]?.organization_id === ORG_B, 'org B enrolled into wrong tenant');
    const validB = await verify(a, credentialB);
    insist(validB.length === 1 && validB[0].organization_id === ORG_B &&
      validB[0].agent_id === enrolledB.rows[0].agent_id, 'machine identity is not tenant-bound');
    await denied(() => revoke(a, 'user_agent_owner_a', ORG_B, enrolledB.rows[0].agent_id),
      '42501', 'cross-tenant revoke B');
    console.log('PASS: second customer enrollment stays separate; foreign owner cannot revoke');
    console.log('========== PHASE 2E3C5D7 SYNTHETIC AGENT CREDENTIAL REHEARSAL PASSED ==========');
    console.log('NOTE: NO public endpoint, credential distribution, TLS, deployment or production migration exists');
  } finally {
    await Promise.all([a, b, c].filter(Boolean).map(client => client.end().catch(() => {})));
  }
}
main().catch(e => {
  console.error(e instanceof Error ? e.message.replace(/[A-Za-z0-9_-]{43}/g, '[REDACTED]') : 'Unknown rehearsal error');
  process.exitCode = 1;
});
