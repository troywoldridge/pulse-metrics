import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@workos-inc/authkit-react';

type VerificationState = 'checking' | 'verified' | 'rejected' | 'unavailable';
type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isOrganization(value: unknown): value is OrganizationSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const org = value as Partial<OrganizationSummary>;
  return typeof org.id === 'string' && UUID.test(org.id) &&
    typeof org.name === 'string' && org.name.length > 0 &&
    typeof org.slug === 'string' && SLUG.test(org.slug) &&
    ['owner', 'admin', 'member', 'viewer'].includes(org.role ?? '');
}

function suggestedSlug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
}

/**
 * Authentication and organization-onboarding holding screen.
 * Monitoring, tenant data views and WebSockets remain disabled until the
 * separate authorization and real-telemetry milestones are complete.
 */
export function AuthenticatedBoundary() {
  const { user, isLoading, signIn, signOut, getAccessToken } = useAuth();
  const [verification, setVerification] = useState<VerificationState>('checking');
  const [verifiedSubject, setVerifiedSubject] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  useEffect(() => {
    if (isLoading || !user) return;
    const expectedSubject = user.id;
    let cancelled = false;
    setVerification('checking');
    setVerifiedSubject(null);
    setOrganizations([]);
    setFormError('');
    setFormSuccess('');

    async function loadAccount() {
      try {
        const token = await getAccessToken();
        if (!token) {
          if (!cancelled) setVerification('rejected');
          return;
        }
        const authHeader = { Authorization: `Bearer ${token}` };
        const identityResponse = await fetch('/api/auth/me', {
          headers: authHeader, cache: 'no-store',
        });
        if (cancelled) return;
        if (identityResponse.status === 401) {
          setVerification('rejected');
          return;
        }
        if (!identityResponse.ok) {
          setVerification('unavailable');
          return;
        }
        const identity: unknown = await identityResponse.json();
        const profile = identity as { provider?: string; subject?: string; userId?: string };
        if (profile?.provider !== 'workos' || profile.subject !== expectedSubject ||
            typeof profile.userId !== 'string' || !UUID.test(profile.userId)) {
          setVerification('rejected');
          return;
        }

        const organizationResponse = await fetch('/api/organizations', {
          headers: authHeader, cache: 'no-store',
        });
        if (cancelled) return;
        if (organizationResponse.status === 401) {
          setVerification('rejected');
          return;
        }
        if (!organizationResponse.ok) {
          setVerification('unavailable');
          return;
        }
        const result: unknown = await organizationResponse.json();
        const list = (result as { organizations?: unknown })?.organizations;
        if (!Array.isArray(list) || !list.every(isOrganization)) {
          setVerification('unavailable');
          return;
        }
        if (!cancelled) {
          setOrganizations(list);
          setVerifiedSubject(expectedSubject);
          setVerification('verified');
        }
      } catch {
        if (!cancelled) setVerification('unavailable');
      }
    }

    void loadAccount();
    return () => { cancelled = true; };
  }, [getAccessToken, isLoading, user?.id, attempt]);

  const ready = !isLoading && !!user && verifiedSubject === user.id &&
    verification === 'verified';

  function changeName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(suggestedSlug(value));
    setFormError('');
    setFormSuccess('');
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || creating || !user) return;
    const proposedName = name.trim();
    if (!proposedName || proposedName.length > 160 || !SLUG.test(slug) || slug.length > 80) {
      setFormError('Enter an organization name and a lowercase slug containing letters, numbers or hyphens.');
      return;
    }
    setCreating(true);
    setFormError('');
    setFormSuccess('');
    try {
      const token = await getAccessToken();
      if (!token) {
        setVerification('rejected');
        setVerifiedSubject(null);
        return;
      }
      const response = await fetch('/api/organizations', {
        method: 'POST',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: proposedName, slug }),
      });
      if (response.status === 401) {
        setVerification('rejected');
        setVerifiedSubject(null);
        return;
      }
      if (response.status === 409) {
        setFormError('This organization URL slug is already in use. Try a different one.');
        return;
      }
      if (!response.ok) {
        setFormError('Could not create the organization. Please try again.');
        return;
      }
      const result: unknown = await response.json();
      const created = (result as { organization?: unknown })?.organization;
      if (!isOrganization(created) || created.role !== 'owner') {
        setFormError('Organization was created, but the response was unexpected. Refresh to check it.');
        return;
      }
      setOrganizations(previous => [...previous.filter(org => org.id !== created.id), created]
        .sort((a, b) => a.name.localeCompare(b.name)));
      setName('');
      setSlug('');
      setSlugEdited(false);
      setFormSuccess(`${created.name} was created. Your role is owner.`);
    } catch {
      setFormError('Connection lost while creating the organization. Refresh to check before retrying.');
    } finally {
      setCreating(false);
    }
  }

  const message = !user
    ? 'Sign in to continue to Pulse Metrics.'
    : verification === 'checking'
      ? 'Verifying your session and loading your organizations…'
      : verification === 'rejected'
        ? 'The server could not validate your session. Sign out and sign in again.'
        : verification === 'unavailable'
          ? 'Account or organization loading is unavailable. Check the local API and database connection, then retry.'
          : 'Your WorkOS identity is linked to PostgreSQL. You can now create an organization. Monitoring remains locked until tenant-safe data access is ready.';

  return (
    <main className="min-h-screen bg-neutral-950 px-5 py-12 text-neutral-100 flex items-center justify-center">
      <div className="w-full max-w-2xl space-y-6">
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-7 shadow-xl">
          <p className="text-sm uppercase tracking-widest text-cyan-400">Pulse Metrics</p>
          <h1 className="mt-3 text-3xl font-semibold">Secure access</h1>
          <p className="mt-5 text-neutral-300 leading-relaxed">
            {isLoading ? 'Loading your authentication session…' : message}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {!isLoading && !user && (
              <button type="button" onClick={() => void signIn()}
                className="rounded-lg bg-cyan-500 px-5 py-2.5 font-semibold text-neutral-950 hover:bg-cyan-400">
                Sign in
              </button>
            )}
            {!isLoading && user && verification !== 'checking' && !ready && (
              <button type="button" onClick={() => setAttempt(count => count + 1)}
                className="rounded-lg border border-neutral-600 px-5 py-2.5 hover:bg-neutral-800">
                Retry verification
              </button>
            )}
            {!isLoading && user && (
              <button type="button" onClick={() => {
                setVerifiedSubject(null);
                setOrganizations([]);
                void signOut();
              }} className="rounded-lg border border-neutral-600 px-5 py-2.5 hover:bg-neutral-800">
                Sign out
              </button>
            )}
          </div>
          {user && <p className="mt-6 text-sm text-neutral-500">Signed in as {user.email}</p>}
        </section>

        {ready && (
          <>
            <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-7">
              <h2 className="text-xl font-semibold">Your organizations</h2>
              <p className="mt-2 text-sm text-neutral-400">
                Only organizations you belong to appear here. Monitoring is not yet enabled.
              </p>
              {organizations.length === 0 ? (
                <p className="mt-5 rounded-lg border border-dashed border-neutral-700 px-4 py-5 text-neutral-300">
                  You don't belong to an organization yet. Create one below to get started.
                </p>
              ) : (
                <ul className="mt-5 space-y-3">
                  {organizations.map(org => (
                    <li key={org.id} className="rounded-lg border border-neutral-700 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <span className="font-semibold">{org.name}</span>
                        <span className="text-xs font-semibold uppercase tracking-wide text-cyan-400">{org.role}</span>
                      </div>
                      <p className="mt-1 text-sm text-neutral-400">{org.slug}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-7">
              <h2 className="text-xl font-semibold">Create organization</h2>
              <p className="mt-2 text-sm text-neutral-400">
                You'll become the owner of the new organization. You cannot choose an existing organization or assign someone else's role.
              </p>
              <form onSubmit={event => void createOrganization(event)} className="mt-5 space-y-4">
                <div>
                  <label htmlFor="organization-name" className="mb-2 block text-sm text-neutral-200">Organization name</label>
                  <input id="organization-name" type="text" autoComplete="organization"
                    value={name} onChange={event => changeName(event.target.value)}
                    required maxLength={160} disabled={creating} placeholder="Example Company"
                    className="w-full rounded-lg border border-neutral-600 bg-neutral-950 px-4 py-3 text-neutral-100 outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label htmlFor="organization-slug" className="mb-2 block text-sm text-neutral-200">Organization URL slug</label>
                  <input id="organization-slug" type="text" value={slug}
                    onChange={event => { setSlug(event.target.value); setSlugEdited(true); setFormError(''); }}
                    required maxLength={80} disabled={creating} placeholder="example-company"
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    className="w-full rounded-lg border border-neutral-600 bg-neutral-950 px-4 py-3 text-neutral-100 outline-none focus:border-cyan-500" />
                  <p className="mt-2 text-xs text-neutral-500">Lowercase letters, numbers, and single hyphens between words.</p>
                </div>
                {formError && <p role="alert" className="text-sm text-rose-400">{formError}</p>}
                {formSuccess && <p role="status" className="text-sm text-emerald-400">{formSuccess}</p>}
                <button type="submit" disabled={creating}
                  className="rounded-lg bg-cyan-500 px-5 py-2.5 font-semibold text-neutral-950 hover:bg-cyan-400 disabled:opacity-50">
                  {creating ? 'Creating organization…' : 'Create organization'}
                </button>
              </form>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
