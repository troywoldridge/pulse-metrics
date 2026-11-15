/**
 * D15C-5P — standalone local-only history preview UI.
 * This component is NOT imported by the production application entry point.
 * Organization choices come from the authenticated API; agent UUID is entered
 * explicitly by the developer until tenant-safe agent discovery is reviewed.
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useAuth } from '@workos-inc/authkit-react';
import { AuthenticatedHistoryDashboard } from './AuthenticatedHistoryDashboard.js';
import {
  canRequestPreviewHistory, readPreviewOrganizations,
  type PreviewOrganization, type PreviewOrganizationRead,
} from '../monitoring/preview-organization-client.js';

interface OrganizationLoad {
  readonly subject: string;
  readonly outcome: PreviewOrganizationRead;
}
interface ActiveSelection {
  readonly subject: string;
  readonly organizationId: string;
  readonly agentId: string;
}

export function LocalHistoryPreview() {
  const { user, isLoading, signIn, signOut, getAccessToken } = useAuth();
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;
  const subject = user?.id ?? '';
  const [loaded, setLoaded] = useState<OrganizationLoad | null>(null);
  const [organizationId, setOrganizationId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [active, setActive] = useState<ActiveSelection | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (isLoading || !subject) return;
    let canceled = false;
    const controller = new AbortController();
    void readPreviewOrganizations({
      getAccessToken: () => tokenRef.current(),
      signal: controller.signal,
    }).then(outcome => {
      if (!canceled) setLoaded({ subject, outcome });
    });
    return () => {
      canceled = true;
      controller.abort();
    };
  }, [isLoading, subject, attempt]);

  const outcome = !isLoading && subject && loaded?.subject === subject
    ? loaded.outcome : null;
  const organizations: readonly PreviewOrganization[] = outcome?.ok ? outcome.organizations : [];
  const currentSelection = active?.subject === subject && active.organizationId === organizationId &&
    active.agentId === agentId && canRequestPreviewHistory(organizationId, agentId, organizations)
    ? active : null;

  function chooseOrganization(value: string) {
    setOrganizationId(value);
    setAgentId('');
    setActive(null);
    setFormError('');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedAgentId = agentId.trim();
    if (!subject || !outcome?.ok ||
        !canRequestPreviewHistory(organizationId, normalizedAgentId, organizations)) {
      setFormError('Choose an authorized organization and enter a valid agent UUID.');
      setActive(null);
      return;
    }
    setAgentId(normalizedAgentId);
    setActive({ subject, organizationId, agentId: normalizedAgentId });
    setFormError('');
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-5 py-8 text-neutral-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-800 pb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400">Pulse Metrics · Development preview</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Historical monitoring</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
              Read-only, locally served history from PostgreSQL. This does not indicate live connectivity or agent health.
            </p>
          </div>
          {user ? (
            <button type="button" onClick={() => {
              setLoaded(null); setOrganizationId(''); setAgentId(''); setActive(null);
              void signOut();
            }} className="rounded-lg border border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-800">Sign out</button>
          ) : null}
        </header>

        <section className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-200" role="note">
          Local development only. Public monitoring is disabled. Historical measurements are not a live status feed.
        </section>

        {isLoading && <p role="status">Checking WorkOS session…</p>}
        {!isLoading && !user && (
          <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
            <p>Sign in with WorkOS to request your organization's recorded history.</p>
            <button type="button" onClick={() => void signIn()}
              className="mt-4 rounded-lg bg-cyan-500 px-5 py-2 font-semibold text-neutral-950 hover:bg-cyan-400">Sign in</button>
          </section>
        )}

        {!isLoading && user && !outcome && <p role="status">Loading authorized organizations…</p>}
        {!isLoading && user && outcome && !outcome.ok && (
          <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6" role="alert">
            <p className="text-amber-200">{outcome.reason === 'authentication_required'
              ? 'Your session needs to be verified again.'
              : 'Organizations are unavailable. No monitoring data was loaded.'}</p>
            <button type="button" onClick={() => {
              setLoaded(null); setActive(null); setAttempt(v => v + 1);
            }} className="mt-4 rounded-lg border border-neutral-600 px-4 py-2 text-sm">Retry</button>
          </section>
        )}

        {!isLoading && user && outcome?.ok && (
          <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="text-xl font-semibold">Choose your organization and agent</h2>
            <p className="mt-2 text-sm text-neutral-400">
              Organizations are loaded through the authenticated API. Agent discovery is not enabled yet;
              enter the UUID of an existing agent you are authorized to monitor.
            </p>
            {organizations.length === 0 ? (
              <p className="mt-5 text-sm text-amber-200" role="status">
                No authorized organizations were returned. Monitoring has not been enabled.
              </p>
            ) : (
              <form onSubmit={submit} className="mt-5 grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
                <div>
                  <label htmlFor="preview-organization" className="mb-2 block text-sm">Organization</label>
                  <select id="preview-organization" value={organizationId}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => chooseOrganization(event.target.value)}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-sm">
                    <option value="">Choose an organization</option>
                    {organizations.map(org => <option key={org.id} value={org.id}>{org.name} ({org.role})</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="preview-agent" className="mb-2 block text-sm">Existing agent UUID</label>
                  <input id="preview-agent" type="text" maxLength={36} spellCheck={false}
                    autoComplete="off" value={agentId} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => { setAgentId(event.target.value); setActive(null); setFormError(''); }}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 p-3 font-mono text-xs" />
                </div>
                <button type="submit" className="rounded-lg bg-cyan-500 px-5 py-3 text-sm font-semibold text-neutral-950 hover:bg-cyan-400">
                  Load history
                </button>
                {formError && <p role="alert" className="text-sm text-amber-300 md:col-span-3">{formError}</p>}
              </form>
            )}
          </section>
        )}

        {currentSelection && (
          <AuthenticatedHistoryDashboard key={`${subject}:${organizationId}:${agentId}`}
            organizationId={currentSelection.organizationId}
            agentId={currentSelection.agentId}
            agentLabel="Selected authorized agent" enabled={true} />
        )}
      </div>
    </main>
  );
}
