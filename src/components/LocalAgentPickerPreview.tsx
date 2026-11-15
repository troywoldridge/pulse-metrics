/**
 * D15C-5Q — separate local-only historical dashboard with tenant-scoped agent picker.
 * Does not import legacy monitoring, invent agents, or imply a live status feed.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@workos-inc/authkit-react';
import { AuthenticatedHistoryDashboard } from './AuthenticatedHistoryDashboard.js';
import {
  readPreviewOrganizations, type PreviewOrganizationRead, type PreviewOrganization,
} from '../monitoring/preview-organization-client.js';
import { readPreviewAgents, type PreviewAgentRead } from '../monitoring/preview-agent-client.js';
import { selectListedAgent } from '../server/monitoring/agent-list-contract.js';

interface OrganizationLoad { readonly subject: string; readonly result: PreviewOrganizationRead }
interface AgentLoad { readonly subject: string; readonly organizationId: string; readonly result: PreviewAgentRead }
interface Selection { readonly subject: string; readonly organizationId: string; readonly agentId: string }

export function LocalAgentPickerPreview() {
  const { user, isLoading, signIn, signOut, getAccessToken } = useAuth();
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;
  const subject = user?.id ?? '';
  const [orgLoad, setOrgLoad] = useState<OrganizationLoad | null>(null);
  const [agentLoad, setAgentLoad] = useState<AgentLoad | null>(null);
  const [orgChoice, setOrgChoice] = useState('');
  const [agentChoice, setAgentChoice] = useState('');
  const [active, setActive] = useState<Selection | null>(null);
  const [orgAttempt, setOrgAttempt] = useState(0);
  const [agentAttempt, setAgentAttempt] = useState(0);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (isLoading || !subject) return;
    let cancelled = false;
    const controller = new AbortController();
    void readPreviewOrganizations({
      getAccessToken: () => tokenRef.current(), signal: controller.signal,
    }).then(result => { if (!cancelled) setOrgLoad({ subject, result }); });
    return () => { cancelled = true; controller.abort(); };
  }, [isLoading, subject, orgAttempt]);

  const orgResult = !isLoading && subject && orgLoad?.subject === subject ? orgLoad.result : null;
  const organizations: readonly PreviewOrganization[] = orgResult?.ok ? orgResult.organizations : [];
  const chosenOrg = organizations.some(org => org.id === orgChoice)
    ? orgChoice : organizations.length === 1 ? organizations[0].id : '';

  useEffect(() => {
    if (!chosenOrg || !subject || !orgResult?.ok) return;
    let cancelled = false;
    const controller = new AbortController();
    void readPreviewAgents({
      organizationId: chosenOrg,
      authorizedOrganizations: orgResult.organizations,
      getAccessToken: () => tokenRef.current(), signal: controller.signal,
    }).then(result => { if (!cancelled) setAgentLoad({ subject, organizationId: chosenOrg, result }); });
    return () => { cancelled = true; controller.abort(); };
  }, [chosenOrg, subject, orgResult, agentAttempt]);

  const agentResult = agentLoad?.subject === subject && agentLoad.organizationId === chosenOrg
    ? agentLoad.result : null;
  const agentData = agentResult?.ok ? agentResult.data : null;
  const listedAgent = selectListedAgent(agentData, chosenOrg, agentChoice);
  const activeAgent = active?.subject === subject && active.organizationId === chosenOrg &&
    active.agentId === agentChoice ? listedAgent : null;

  function chooseOrganization(value: string) {
    setOrgChoice(value); setAgentChoice(''); setAgentLoad(null); setActive(null); setFormError('');
  }
  function loadHistory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!subject || !chosenOrg || !listedAgent) {
      setFormError('Choose an authorized organization and a listed monitoring agent.');
      setActive(null);
      return;
    }
    setActive({ subject, organizationId: chosenOrg, agentId: listedAgent.id });
    setFormError('');
  }

  return <main className="min-h-screen bg-neutral-950 px-5 py-8 text-neutral-100">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-800 pb-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400">Pulse Metrics · Local development preview</p>
          <h1 className="mt-2 text-3xl font-semibold">Historical monitoring</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
            Choose a server by name. Read-only historical data from PostgreSQL; not a live agent-health feed.
          </p>
        </div>
        {user && <button type="button" className="rounded-lg border border-neutral-600 px-4 py-2 text-sm"
          onClick={() => {
            setOrgLoad(null); setAgentLoad(null); setOrgChoice(''); setAgentChoice(''); setActive(null);
            void signOut();
          }}>Sign out</button>}
      </header>
      <section role="note" className="rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-200">
        Local development only. Public monitoring is disabled. Agent status is recorded data, not a live connectivity check.
      </section>
      {isLoading && <p role="status">Checking WorkOS session…</p>}
      {!isLoading && !user && <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <p>Sign in with WorkOS to view your authorized organizations and their registered agents.</p>
        <button type="button" onClick={() => void signIn()}
          className="mt-4 rounded-lg bg-cyan-500 px-5 py-2 font-semibold text-neutral-950">Sign in</button>
      </section>}
      {!isLoading && user && !orgResult && <p role="status">Loading authorized organizations…</p>}
      {!isLoading && user && orgResult && !orgResult.ok && <section role="alert"
        className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <p className="text-amber-200">{orgResult.reason === 'authentication_required'
          ? 'Your session must be verified again.' : 'Organization discovery is unavailable.'}</p>
        <button type="button" className="mt-4 rounded-lg border border-neutral-600 px-4 py-2"
          onClick={() => { setOrgLoad(null); setOrgAttempt(v => v + 1); }}>Retry</button>
      </section>}
      {!isLoading && user && orgResult?.ok && <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="text-xl font-semibold">Select a monitored server</h2>
        <p className="mt-2 text-sm text-neutral-400">Only agents registered to your selected organization are listed. No UUID entry required.</p>
        {organizations.length === 0 ? <p role="status" className="mt-4 text-amber-200">
          No authorized organizations were returned. Monitoring has not been enabled.
        </p> : <form onSubmit={loadHistory} className="mt-5 grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div>
            <label htmlFor="agent-preview-organization" className="mb-2 block text-sm">Organization</label>
            <select id="agent-preview-organization" value={chosenOrg}
              onChange={event => chooseOrganization(event.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-sm">
              <option value="">Choose an organization</option>
              {organizations.map(org => <option key={org.id} value={org.id}>{org.name} ({org.role})</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="agent-preview-agent" className="mb-2 block text-sm">Monitored server</label>
            <select id="agent-preview-agent" value={listedAgent?.id ?? ''}
              disabled={!agentData || agentData.agents.length === 0}
              onChange={event => { setAgentChoice(event.target.value); setActive(null); setFormError(''); }}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-sm">
              <option value="">{!chosenOrg ? 'Select an organization first'
                : !agentResult ? 'Loading registered agents…'
                  : !agentResult.ok ? 'Agent list unavailable'
                    : agentData?.agents.length === 0 ? 'No agents enrolled' : 'Choose a server'}</option>
              {agentData?.agents.map(agent => <option key={agent.id} value={agent.id}>
                {agent.displayName} · {agent.hostname} ({agent.platform})
              </option>)}
            </select>
          </div>
          <button type="submit" disabled={!listedAgent}
            className="rounded-lg bg-cyan-500 px-5 py-3 text-sm font-semibold text-neutral-950 disabled:opacity-40">
            Load history
          </button>
          {agentResult && !agentResult.ok && <div role="alert" className="text-amber-200 text-sm md:col-span-3">
            {agentResult.reason === 'authentication_required' ? 'Session verification required.'
              : agentResult.reason === 'access_denied' ? 'Organization access was denied.'
                : 'Registered agents could not be loaded.'}
            <button type="button" onClick={() => { setAgentLoad(null); setAgentAttempt(v => v + 1); }}
              className="ml-3 underline">Retry agents</button>
          </div>}
          {agentData?.agents.length === 0 && <p className="text-amber-200 text-sm md:col-span-3" role="status">
            No monitoring agents are enrolled in this organization yet. The next step is secure agent enrollment—not entering an arbitrary UUID.
          </p>}
          {listedAgent && <p className="text-neutral-400 text-xs md:col-span-3">
            Recorded status: {listedAgent.status} · Last recorded contact: {listedAgent.lastSeenAt ?? 'not recorded'}.
            These values do not prove the server is currently online.
          </p>}
          {formError && <p role="alert" className="text-amber-200 text-sm md:col-span-3">{formError}</p>}
        </form>}
      </section>}
      {activeAgent && <AuthenticatedHistoryDashboard
        key={`${subject}:${chosenOrg}:${activeAgent.id}`}
        organizationId={chosenOrg} agentId={activeAgent.id}
        agentLabel={activeAgent.displayName} enabled={true} />}
    </div>
  </main>;
}
