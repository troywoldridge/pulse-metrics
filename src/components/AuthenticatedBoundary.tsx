import { useEffect, useState } from 'react';
import { useAuth } from '@workos-inc/authkit-react';

type VerificationState = 'checking' | 'verified' | 'rejected' | 'unavailable';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A holding screen. The old monitoring dashboard stays locked until
 * organization membership, role authorization and tenant-safe APIs exist.
 */
export function AuthenticatedBoundary() {
  const { user, isLoading, signIn, signOut, getAccessToken } = useAuth();
  const [verification, setVerification] = useState<VerificationState>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (isLoading || !user) return;
    let cancelled = false;
    setVerification('checking');

    async function checkServerIdentity() {
      try {
        const token = await getAccessToken();
        if (!token) {
          if (!cancelled) setVerification('rejected');
          return;
        }
        const response = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (cancelled) return;
        if (response.status === 401) {
          setVerification('rejected');
          return;
        }
        if (!response.ok) {
          setVerification('unavailable');
          return;
        }
        const result: unknown = await response.json();
        const identity = result as { provider?: string; subject?: string; userId?: string };
        setVerification(identity?.provider === 'workos' &&
          identity.subject === user?.id &&
          typeof identity.userId === 'string' && UUID.test(identity.userId)
          ? 'verified'
          : 'rejected');
      } catch {
        if (!cancelled) setVerification('unavailable');
      }
    }

    void checkServerIdentity();
    return () => { cancelled = true; };
  }, [getAccessToken, isLoading, user?.id, attempt]);

  const message = !user
    ? 'Sign in to continue to Pulse Metrics.'
    : verification === 'verified'
      ? 'Your WorkOS identity is linked to your Pulse Metrics account. Organization onboarding is next. The prototype dashboard remains locked until tenant authorization is complete.'
      : verification === 'checking'
        ? 'Securely verifying your session and linking your account…'
        : verification === 'rejected'
          ? 'The server could not validate your session and identity. Sign out and sign in again.'
          : 'Account verification or provisioning is temporarily unavailable. Check the local API and database connection, then retry.';

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-950 px-5 text-neutral-100">
      <section className="w-full max-w-xl rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl">
        <p className="text-sm uppercase tracking-widest text-cyan-400">Pulse Metrics</p>
        <h1 className="mt-3 text-3xl font-semibold">Secure access</h1>
        <p className="mt-5 text-neutral-300 leading-relaxed">
          {isLoading ? 'Loading your authentication session…' : message}
        </p>
        <div className="mt-7 flex gap-3 flex-wrap">
          {!isLoading && !user && (
            <button type="button" onClick={() => void signIn()}
              className="rounded-lg bg-cyan-500 px-5 py-2.5 font-semibold text-neutral-950 hover:bg-cyan-400">
              Sign in
            </button>
          )}
          {!isLoading && user && verification !== 'checking' && verification !== 'verified' && (
            <button type="button" onClick={() => setAttempt(count => count + 1)}
              className="rounded-lg border border-neutral-600 px-5 py-2.5 hover:bg-neutral-800">
              Retry verification
            </button>
          )}
          {!isLoading && user && (
            <button type="button" onClick={() => void signOut()}
              className="rounded-lg border border-neutral-600 px-5 py-2.5 hover:bg-neutral-800">
              Sign out
            </button>
          )}
        </div>
        {user && <p className="mt-6 text-sm text-neutral-500">Signed in as {user.email}</p>}
      </section>
    </main>
  );
}
