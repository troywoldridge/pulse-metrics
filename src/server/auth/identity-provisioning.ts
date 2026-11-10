import { sql } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import type { AuthenticatedIdentity } from './workos-auth.js';

const WORKOS_USER_SUBJECT = /^user_[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Map a server-verified WorkOS identity to a stable Pulse Metrics user UUID.
 *
 * Never call this with a browser-provided subject or a decoded-but-unverified
 * JWT. It must be invoked only after requireWorkOSUser verifies the bearer.
 *
 * The database function is a separately reviewed, least-privilege security
 * boundary. This adapter cannot create organizations or grant membership.
 */
export async function resolveAuthenticatedUserId(
  identity: AuthenticatedIdentity,
): Promise<string> {
  if (
    identity.provider !== 'workos' ||
    typeof identity.subject !== 'string' ||
    identity.subject.length > 255 ||
    !WORKOS_USER_SUBJECT.test(identity.subject) ||
    typeof identity.sessionId !== 'string' ||
    identity.sessionId.length === 0
  ) {
    throw new TypeError('Verified WorkOS identity is required.');
  }

  // Drizzle parameterizes the verified subject; do not interpolate into raw SQL.
  const result = await getDatabase().execute(
    sql`SELECT public.resolve_workos_user(${identity.subject}) AS user_id`,
  );
  const userId = result.rows[0]?.user_id;

  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new Error('Identity provisioning did not return a valid user UUID.');
  }

  return userId;
}
