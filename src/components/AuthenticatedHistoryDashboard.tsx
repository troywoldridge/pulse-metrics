/**
 * D15C-5O — optional WorkOS-connected history dashboard foundation.
 *
 * UNMOUNTED by the application. A future reviewed parent must explicitly
 * opt in after selecting a verified membership and monitored agent.
 * The server independently verifies membership/agent; client props are not
 * authorization and cannot open up the server.ts 503 monitoring hold.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@workos-inc/authkit-react';
import type { HistoryRange } from '../server/monitoring/history-contract.js';
import { readTenantHistory } from '../monitoring/history-client.js';
import { historyDisplayState, type DashboardHistoryState } from '../monitoring/history-state.js';
import { RealHistoryPanel } from './RealHistoryPanel.js';

interface AuthenticatedHistoryDashboardProps {
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentLabel?: string;
  /** Must stay false until an independently reviewed same-origin integration. */
  readonly enabled?: boolean;
}

const disabled: DashboardHistoryState = { phase: 'disabled' };

export function AuthenticatedHistoryDashboard({
  organizationId, agentId, agentLabel, enabled = false,
}: AuthenticatedHistoryDashboardProps) {
  const { user, isLoading, getAccessToken } = useAuth();
  const accessTokenRef = useRef(getAccessToken);
  accessTokenRef.current = getAccessToken;
  const [range, setRange] = useState<HistoryRange>('1h');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value: DashboardHistoryState } | null>(null);
  const subject = user?.id ?? '';
  const key = `${subject}:${organizationId}:${agentId}:${range}:${refresh}`;
  const active = enabled && !isLoading && !!subject;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const controller = new AbortController();
    void readTenantHistory({
      organizationId, agentId, range,
      getAccessToken: () => accessTokenRef.current(),
      signal: controller.signal,
    }).then(read => {
      if (!cancelled) {
        setResult({ key, value: historyDisplayState(read, Date.now()) });
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, organizationId, agentId, range, refresh, key]);

  const state: DashboardHistoryState = !active ? disabled
    : result?.key === key ? result.value
      : { phase: 'loading' };

  return <RealHistoryPanel state={state} range={range} agentLabel={agentLabel}
    onRangeChange={setRange} onRefresh={() => setRefresh(value => value + 1)} />;
}
