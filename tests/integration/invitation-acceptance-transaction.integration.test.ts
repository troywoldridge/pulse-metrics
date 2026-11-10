import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { closeDatabase } from '../../src/db/client.js';
import {
  createInvitationAcceptanceService,
  synchronizeAndAcceptInvitation,
  InvitationNotAvailableError,
  InvitationAcceptanceUnavailableError,
} from '../../src/server/auth/invitation-acceptance-service.js';
import type { AuthenticatedIdentity } from '../../src/server/auth/workos-auth.js';

const { SUBJECT_OWNER, SUBJECT_RECIPIENT, SUBJECT_OTHER, ORG_ID, SUFFIX } = process.env;
if (!SUBJECT_OWNER || !SUBJECT_RECIPIENT || !SUBJECT_OTHER || !ORG_ID || !SUFFIX) {
  throw new Error('Missing synthetic invitation-acceptance fixture identifiers.');
}
const email = `recipient.${SUFFIX}@example.invalid`;
const changedEmail = `changed.${SUFFIX}@example.invalid`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const identity: AuthenticatedIdentity = { provider: 'workos', subject: SUBJECT_RECIPIENT, sessionId: 'fixture_session' };
const other: AuthenticatedIdentity = { ...identity, subject: SUBJECT_OTHER };
const secret = () => randomBytes(32).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
let profileEmail: string | null = null;
const otherEmail = `other.${SUFFIX}@example.invalid`;
const accept = createInvitationAcceptanceService({
  lookup: async actual => {
    assert.ok([SUBJECT_RECIPIENT, SUBJECT_OTHER].includes(actual.subject));
    return actual.subject === SUBJECT_OTHER ? otherEmail : profileEmail;
  },
  execute: synchronizeAndAcceptInvitation,
});
const issue = async (token: string, recipientEmail = email) => {
  const response = await client.query(
    'SELECT public.issue_organization_invitation($1,$2,$3,$4,$5,$6) AS id',
    [SUBJECT_OWNER, ORG_ID, recipientEmail, 'viewer', hash(token), new Date(Date.now() + 24 * 3600_000)],
  );
  assert.match(response.rows[0].id, /^[0-9a-f-]{36}$/);
};

// Single integration test preserves fixture ordering and validates every
// transactional transition through actual Drizzle+Postgres restricted role.
test('fresh provider evidence, transaction locks, savepoints and single-use redemption', async () => {
  await client.connect();
  try {
    const role = await client.query('SELECT current_user AS name');
    assert.equal(role.rows[0].name, 'pulse_metrics_app');
    const first = secret();
    await issue(first);

    profileEmail = null;
    await assert.rejects(accept(identity, first), InvitationNotAvailableError);
    const cleared = await client.query(
      'SELECT public.accept_organization_invitation($1,$2)',
      [SUBJECT_RECIPIENT, hash(first)],
    ).catch(e => e);
    assert.equal(cleared.code, 'P0002');

    // Deliberately mismatch the refreshed WorkOS email. The attempted
    // acceptance rolls back to the SAVEPOINT, not the email synchronization.
    profileEmail = changedEmail;
    await assert.rejects(accept(identity, first), InvitationNotAvailableError);
    const stale = await client.query('SELECT public.accept_organization_invitation($1,$2)',
      [SUBJECT_RECIPIENT, hash(first)]).catch(e => e);
    assert.equal(stale.code, 'P0002');
    console.log('PASS: unverified and changed provider email cannot consume pending invitation');

    profileEmail = email;
    const firstAccepted = await accept(identity, first);
    assert.equal(firstAccepted.organizationId, ORG_ID);
    assert.equal(firstAccepted.membershipRole, 'viewer');
    await assert.rejects(accept(identity, first), InvitationNotAvailableError);
    console.log('PASS: intended recipient accepted once and token cannot be replayed');

    const second = secret();
    await issue(second);
    profileEmail = email;
    await assert.rejects(accept(other, second), InvitationNotAvailableError);
    // Recipient already has membership: collision must NOT consume invitation.
    await assert.rejects(accept(identity, second), InvitationNotAvailableError);
    console.log('PASS: wrong recipient and duplicate membership are denied without promotion');

    // New invitation to other account, only one of two concurrent accepts wins.
    const concurrent = secret();
    await issue(concurrent, otherEmail);
    profileEmail = otherEmail;
    const results = await Promise.allSettled([accept(other, concurrent), accept(other, concurrent)]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected' &&
      x.reason instanceof InvitationNotAvailableError).length, 1);
    console.log('PASS: two concurrent attempts yield exactly one membership');

    // Provider failure blocks all DB activity, does not use cached evidence.
    const unavailable = createInvitationAcceptanceService({
      lookup: async () => { throw new Error('provider diagnostic with API key'); },
      execute: async () => { throw new Error('Database should not be called'); },
    });
    await assert.rejects(unavailable(other, secret()), InvitationAcceptanceUnavailableError);
    console.log('PASS: provider outage rejects rather than falling back to cached email');
  } finally {
    await client.end();
    await closeDatabase();
  }
});
