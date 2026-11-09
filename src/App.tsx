/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  HostMetrics,
  WidgetLayoutConfig,
  DashboardSettings,
  HostThresholdMap,
  DEFAULT_THRESHOLDS,
} from './types/metrics';
import { HostView } from './components/HostView';
import { HistoricalView } from './components/HistoricalView';
import { SshTerminalDrawer } from './components/SshTerminalDrawer';
import { LayoutCustomizerModal } from './components/LayoutCustomizerModal';
import { AddHostModal } from './components/AddHostModal';
import { ThresholdConfigModal } from './components/ThresholdConfigModal';
import { formatBitsPerSec } from './utils/metrics-calculator';
import {
  Server,
  Activity,
  Sliders,
  SlidersHorizontal,
  Plus,
  Moon,
  Sun,
  Radio,
  Terminal,
  ShieldCheck,
  Zap,
  Calendar,
  LogIn,
  LogOut,
} from 'lucide-react';
import { useAuth } from '@workos-inc/authkit-react';

const DEFAULT_HOST_THRESHOLDS: HostThresholdMap = {
  'linux-pc': {
    cpu: { warning: 75, critical: 90 },
    memory: { warning: 80, critical: 92 },
    disk: { warning: 85, critical: 95 },
  },
  'work-server': {
    cpu: { warning: 70, critical: 88 },
    memory: { warning: 80, critical: 90 },
    disk: { warning: 80, critical: 92 },
  },
};

const DEFAULT_WIDGETS: WidgetLayoutConfig[] = [
  { id: 'cpu', name: 'CPU Speedometer & Cores', visible: true, order: 0, width: 'third' },
  { id: 'memory', name: 'Memory & Swap Gauge', visible: true, order: 1, width: 'third' },
  { id: 'bandwidth', name: 'Network Bandwidth Dial', visible: true, order: 2, width: 'third' },
  { id: 'speedtest', name: 'Internet Speed & Quality', visible: true, order: 3, width: 'half' },
  { id: 'disk', name: 'Storage & Disk I/O', visible: true, order: 4, width: 'half' },
  { id: 'latency', name: 'Latency & Connection Health', visible: true, order: 5, width: 'third' },
  { id: 'charts', name: 'Time-Series Sparkline History', visible: true, order: 6, width: 'full' },
  { id: 'processes', name: 'Top Processes Inspector', visible: true, order: 7, width: 'full' },
];

export default function App() {
  const { user, isLoading: authLoading, signIn, signOut } = useAuth();
  const [hosts, setHosts] = useState<Record<string, HostMetrics>>({});
  const [activeHostId, setActiveHostId] = useState<string>('all');
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [pollingInterval, setPollingInterval] = useState<number>(1000);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [viewMode, setViewMode] = useState<'grid' | 'compact' | 'focus'>('grid');
  const [widgets, setWidgets] = useState<WidgetLayoutConfig[]>(DEFAULT_WIDGETS);
  const [dashboardMode, setDashboardMode] = useState<'live' | 'historical'>('live');
  const [historicalHostId, setHistoricalHostId] = useState<string>('linux-pc');

  // Modals & Drawers state
  const [terminalHost, setTerminalHost] = useState<HostMetrics | null>(null);
  const [isLayoutModalOpen, setIsLayoutModalOpen] = useState(false);
  const [isAddHostModalOpen, setIsAddHostModalOpen] = useState(false);
  const [isThresholdModalOpen, setIsThresholdModalOpen] = useState(false);
  const [thresholdTargetHostId, setThresholdTargetHostId] = useState<string>('linux-pc');
  const [lastExecResult, setLastExecResult] = useState<any>(null);

  // Host Thresholds State (customized per host)
  const [hostThresholds, setHostThresholds] = useState<HostThresholdMap>(() => {
    try {
      const saved = localStorage.getItem('pulse_thresholds');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      // ignore
    }
    return DEFAULT_HOST_THRESHOLDS;
  });

  const handleSaveThresholds = (newMap: HostThresholdMap) => {
    setHostThresholds(newMap);
    localStorage.setItem('pulse_thresholds', JSON.stringify(newMap));
  };

  const handleOpenThresholds = (hostId?: string) => {
    if (hostId) {
      setThresholdTargetHostId(hostId);
    }
    setIsThresholdModalOpen(true);
  };

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize theme from localStorage
  useEffect(() => {
    const savedTheme = localStorage.getItem('pulse_theme') as 'dark' | 'light' | null;
    const initialTheme = savedTheme || 'dark';
    setTheme(initialTheme);
    if (initialTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

    const savedWidgets = localStorage.getItem('pulse_widgets');
    if (savedWidgets) {
      try {
        setWidgets(JSON.parse(savedWidgets));
      } catch (e) {
        // ignore
      }
    }
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('pulse_theme', nextTheme);
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const handleUpdateWidgets = (newWidgets: WidgetLayoutConfig[]) => {
    setWidgets(newWidgets);
    localStorage.setItem('pulse_widgets', JSON.stringify(newWidgets));
  };

  const handleResetDefaults = () => {
    setWidgets(DEFAULT_WIDGETS);
    localStorage.setItem('pulse_widgets', JSON.stringify(DEFAULT_WIDGETS));
  };

  // WebSocket Connection
  useEffect(() => {
    function connectWs() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onclose = () => {
        setWsConnected(false);
        // Automatic reconnection loop
        reconnectTimeoutRef.current = setTimeout(connectWs, 2000);
      };

      ws.onerror = () => {
        setWsConnected(false);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'init' || data.type === 'metrics_update' || data.type === 'hosts_list_updated') {
            if (data.hosts) {
              setHosts(data.hosts);
            }
            if (data.pollingIntervalMs) {
              setPollingInterval(data.pollingIntervalMs);
            }
          }

          if (data.type === 'speedtest_status') {
            setHosts((prev) => {
              const host = prev[data.hostId];
              if (!host) return prev;
              return {
                ...prev,
                [data.hostId]: {
                  ...host,
                  networkSpeed: data.speed,
                },
              };
            });
          }

          if (data.type === 'ssh_exec_result') {
            setLastExecResult(data);
          }
        } catch (err) {
          console.error('Error parsing WS message:', err);
        }
      };
    }

    connectWs();

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (socketRef.current) socketRef.current.close();
    };
  }, []);

  // Send speedtest command
  const handleRunSpeedTest = (hostId: string) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'trigger_speedtest',
          hostId,
        })
      );
    }
  };

  // Execute SSH command
  const handleExecuteSsh = (command: string, hostId: string) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'exec_ssh',
          command,
          hostId,
        })
      );
    }
  };

  // Add new host
  const handleAddHost = (hostData: {
    name: string;
    hostname: string;
    sshCommand: string;
    connectionType: 'ssh' | 'local' | 'agent';
  }) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'add_host',
          ...hostData,
        })
      );
    }
  };

  // Change interval
  const handleChangeInterval = (intervalMs: number) => {
    setPollingInterval(intervalMs);
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'set_interval',
          intervalMs,
        })
      );
    }
  };

  const hostList = Object.values(hosts);
  const activeHostsToRender =
    activeHostId === 'all'
      ? hostList
      : hostList.filter((h) => h.hostId === activeHostId);

  // Aggregate network metrics for global health bar
  const totalDownloadBps = hostList.reduce((acc, h) => acc + (h.network?.downloadBps || 0), 0);
  const totalUploadBps = hostList.reduce((acc, h) => acc + (h.network?.uploadBps || 0), 0);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 dark:bg-neutral-950 dark:text-neutral-100 flex flex-col antialiased selection:bg-cyan-500 selection:text-white">
      {/* Top Bar Contract (Brand - Nav Links - Primary Action) */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-neutral-800/80 bg-neutral-900/60 backdrop-blur-md sticky top-0 z-40">
        {/* Zone 1: Single text wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <a
            href="/"
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap flex items-center gap-2 hover:opacity-90"
          >
            <Activity className="w-5 h-5 text-cyan-400" />
            <span>PulseMetrics</span>
          </a>
          <span className="flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700/60 text-neutral-300">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-emerald-400' : 'bg-rose-500 animate-pulse'
              }`}
            />
            {wsConnected ? 'WS LIVE' : 'WS CONNECTING'}
          </span>
        </div>

        {/* Zone 2: Navigation Links for Host Filtering */}
        <nav className="hidden md:flex items-center gap-1.5 text-xs font-mono overflow-x-auto py-1">
          <button
            onClick={() => setActiveHostId('all')}
            className={`px-3 py-1.5 rounded-lg transition-all whitespace-nowrap cursor-pointer ${
              activeHostId === 'all'
                ? 'bg-neutral-800 text-white font-semibold border border-neutral-700 shadow-xs'
                : 'text-neutral-400 hover:text-white hover:bg-neutral-800/40'
            }`}
          >
            All Hosts ({hostList.length})
          </button>
          {hostList.map((h) => (
            <button
              key={h.hostId}
              onClick={() => setActiveHostId(h.hostId)}
              className={`px-3 py-1.5 rounded-lg transition-all whitespace-nowrap cursor-pointer flex items-center gap-1.5 ${
                activeHostId === h.hostId
                  ? 'bg-neutral-800 text-cyan-400 font-semibold border border-cyan-800/60 shadow-xs'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-800/40'
              }`}
            >
              <Server className="w-3 h-3" />
              <span>{h.name.split(' (')[0]}</span>
            </button>
          ))}
        </nav>

        {/* Zone 3: Primary Action & Controls */}
        <div className="flex items-center gap-2.5 shrink-0">
          {/* Polling Interval Selector */}
          <div className="hidden sm:flex items-center gap-1 bg-neutral-800/80 p-0.5 rounded-lg text-[11px] font-mono border border-neutral-700/60">
            {[500, 1000, 2000].map((ms) => (
              <button
                key={ms}
                onClick={() => handleChangeInterval(ms)}
                className={`px-2 py-1 rounded cursor-pointer transition-colors ${
                  pollingInterval === ms
                    ? 'bg-neutral-700 text-white font-medium shadow-xs'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
                title={`Poll every ${ms / 1000}s`}
              >
                {ms / 1000}s
              </button>
            ))}
          </div>

          {/* Thresholds & Alert Zones Configuration */}
          <button
            onClick={() => handleOpenThresholds(activeHostId !== 'all' ? activeHostId : undefined)}
            className="p-2 rounded-lg bg-neutral-800/80 hover:bg-neutral-700 text-cyan-400 border border-neutral-700/60 transition-all cursor-pointer flex items-center gap-1.5"
            title="Configure Thresholds & Alert Zones"
            aria-label="Configure Thresholds"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>

          {/* Customize Layout */}
          <button
            onClick={() => setIsLayoutModalOpen(true)}
            className="p-2 rounded-lg bg-neutral-800/80 hover:bg-neutral-700 text-neutral-300 border border-neutral-700/60 transition-all cursor-pointer"
            title="Customize Widget Layout"
            aria-label="Customize Layout"
          >
            <Sliders className="w-4 h-4" />
          </button>

          {/* Add Server */}
          <button
            onClick={() => setIsAddHostModalOpen(true)}
            className="px-3 py-1.5 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer shadow-xs whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Host</span>
          </button>

          {/* Theme Toggle */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg bg-neutral-800/80 hover:bg-neutral-700 text-neutral-300 border border-neutral-700/60 transition-all cursor-pointer"
            aria-label="Toggle Theme"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* Account (WorkOS AuthKit) */}
          {!authLoading &&
            (user ? (
              <div className="flex items-center gap-2">
                <span className="hidden lg:inline text-[11px] font-mono text-neutral-400 max-w-[180px] truncate" title={user.email}>
                  {user.email}
                </span>
                <button
                  onClick={() => signOut()}
                  className="p-2 rounded-lg bg-neutral-800/80 hover:bg-neutral-700 text-neutral-300 border border-neutral-700/60 transition-all cursor-pointer"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => signIn()}
                className="px-3 py-1.5 text-xs font-medium text-neutral-200 bg-neutral-800/80 hover:bg-neutral-700 border border-neutral-700/60 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign in</span>
              </button>
            ))}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 space-y-6">
        {/* Global Connection Health & Telemetry Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 bg-neutral-900/80 border border-neutral-800 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase font-mono tracking-wider text-neutral-400">
                Active Targets
              </div>
              <div className="text-lg font-bold font-mono text-white tabular-nums">
                {hostList.length} Connected
              </div>
            </div>
            <Server className="w-4 h-4 text-emerald-400" />
          </div>

          <div className="p-3 bg-neutral-900/80 border border-neutral-800 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase font-mono tracking-wider text-neutral-400">
                Aggregate Bandwidth
              </div>
              <div className="text-sm font-bold font-mono text-cyan-400 tabular-nums">
                ↓ {formatBitsPerSec(totalDownloadBps * 8)}
              </div>
              <div className="text-[10px] font-mono text-purple-400 tabular-nums">
                ↑ {formatBitsPerSec(totalUploadBps * 8)}
              </div>
            </div>
            <Radio className="w-4 h-4 text-cyan-400" />
          </div>

          <div className="p-3 bg-neutral-900/80 border border-neutral-800 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase font-mono tracking-wider text-neutral-400">
                SSH Target Shortcut
              </div>
              <div className="text-sm font-bold font-mono text-emerald-400 truncate">
                ssh work
              </div>
              <div className="text-[10px] font-mono text-neutral-500">
                Auto-Auth / Keyed
              </div>
            </div>
            <Terminal className="w-4 h-4 text-emerald-400" />
          </div>

          <div className="p-3 bg-neutral-900/80 border border-neutral-800 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase font-mono tracking-wider text-neutral-400">
                WebSocket Health
              </div>
              <div className="text-sm font-bold font-mono text-emerald-400 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Synchronized</span>
              </div>
              <div className="text-[10px] font-mono text-neutral-500">
                {pollingInterval / 1000}s tick stream
              </div>
            </div>
            <Zap className="w-4 h-4 text-emerald-400" />
          </div>
        </div>

        {/* Workspace Mode Switcher (Live Gauges vs Historical Analytics) */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-1.5 p-1 bg-neutral-900 border border-neutral-800 rounded-xl">
            <button
              onClick={() => setDashboardMode('live')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium font-mono transition-all cursor-pointer ${
                dashboardMode === 'live'
                  ? 'bg-neutral-800 text-cyan-400 font-semibold shadow-xs border border-neutral-700/60'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Live Telemetry &amp; Dials</span>
            </button>
            <button
              onClick={() => setDashboardMode('historical')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium font-mono transition-all cursor-pointer ${
                dashboardMode === 'historical'
                  ? 'bg-neutral-800 text-cyan-400 font-semibold shadow-xs border border-neutral-700/60'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <Calendar className="w-3.5 h-3.5 text-amber-400" />
              <span>Historical Performance &amp; Anomalies</span>
            </button>
          </div>

          {dashboardMode === 'historical' && (
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-neutral-400">Target Host:</span>
              <select
                value={historicalHostId}
                onChange={(e) => setHistoricalHostId(e.target.value)}
                className="bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500 font-mono"
              >
                {hostList.map((h) => (
                  <option key={h.hostId} value={h.hostId}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Mobile Host Switcher (Live mode only) */}
        {dashboardMode === 'live' && (
          <div className="md:hidden flex items-center gap-1.5 overflow-x-auto pb-1 text-xs font-mono">
            <button
              onClick={() => setActiveHostId('all')}
              className={`px-3 py-1.5 rounded-lg whitespace-nowrap cursor-pointer ${
                activeHostId === 'all'
                  ? 'bg-neutral-800 text-white font-semibold'
                  : 'text-neutral-400 bg-neutral-900'
              }`}
            >
              All Hosts
            </button>
            {hostList.map((h) => (
              <button
                key={h.hostId}
                onClick={() => setActiveHostId(h.hostId)}
                className={`px-3 py-1.5 rounded-lg whitespace-nowrap cursor-pointer ${
                  activeHostId === h.hostId
                    ? 'bg-cyan-950 text-cyan-400 border border-cyan-800 font-semibold'
                    : 'text-neutral-400 bg-neutral-900'
                }`}
              >
                {h.name.split(' (')[0]}
              </button>
            ))}
          </div>
        )}

        {/* Render Views */}
        {dashboardMode === 'historical' ? (
          <div>
            {hosts[historicalHostId] ? (
              <HistoricalView
                host={hosts[historicalHostId]}
                thresholds={hostThresholds[historicalHostId] || DEFAULT_THRESHOLDS}
                onOpenThresholds={(h) => handleOpenThresholds(h.hostId)}
              />
            ) : hostList[0] ? (
              <HistoricalView
                host={hostList[0]}
                thresholds={hostThresholds[hostList[0].hostId] || DEFAULT_THRESHOLDS}
                onOpenThresholds={(h) => handleOpenThresholds(h.hostId)}
              />
            ) : (
              <div className="p-12 text-center border border-neutral-800 rounded-2xl bg-neutral-900/40 text-neutral-400 font-mono text-xs">
                No host data available for historical view.
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {activeHostsToRender.map((host) => (
              <HostView
                key={host.hostId}
                host={host}
                widgets={widgets}
                viewMode={viewMode}
                thresholds={hostThresholds[host.hostId] || DEFAULT_THRESHOLDS}
                onOpenTerminal={(h) => setTerminalHost(h)}
                onRunSpeedTest={handleRunSpeedTest}
                onOpenThresholds={(h) => handleOpenThresholds(h.hostId)}
                onOpenHistory={(h) => {
                  setHistoricalHostId(h.hostId);
                  setDashboardMode('historical');
                }}
              />
            ))}

            {hostList.length === 0 && (
              <div className="p-12 text-center border border-neutral-800 rounded-2xl bg-neutral-900/40">
                <Activity className="w-8 h-8 text-neutral-600 mx-auto mb-3 animate-spin" />
                <h3 className="text-base font-semibold text-neutral-300">Connecting to Telemetry Stream...</h3>
                <p className="text-xs text-neutral-500 font-mono mt-1">
                  Attempting connection to local Linux prober and remote SSH supervisor.
                </p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Interactive SSH Terminal Drawer */}
      {terminalHost && (
        <SshTerminalDrawer
          isOpen={Boolean(terminalHost)}
          onClose={() => setTerminalHost(null)}
          host={terminalHost}
          onExecuteCommand={handleExecuteSsh}
          lastExecResult={lastExecResult}
        />
      )}

      {/* Threshold Configuration Modal */}
      <ThresholdConfigModal
        isOpen={isThresholdModalOpen}
        onClose={() => setIsThresholdModalOpen(false)}
        hosts={
          hostList.length > 0
            ? hostList.map((h) => ({ hostId: h.hostId, name: h.name }))
            : [
                { hostId: 'linux-pc', name: 'Linux PC (Local Host)' },
                { hostId: 'work-server', name: 'Work Server (ssh work)' },
              ]
        }
        currentThresholds={hostThresholds}
        onSaveThresholds={handleSaveThresholds}
        initialSelectedHostId={thresholdTargetHostId}
      />

      {/* Layout Customizer Modal */}
      <LayoutCustomizerModal
        isOpen={isLayoutModalOpen}
        onClose={() => setIsLayoutModalOpen(false)}
        widgets={widgets}
        onUpdateWidgets={handleUpdateWidgets}
        viewMode={viewMode}
        onUpdateViewMode={setViewMode}
        onResetDefaults={handleResetDefaults}
      />

      {/* Add Host Modal */}
      <AddHostModal
        isOpen={isAddHostModalOpen}
        onClose={() => setIsAddHostModalOpen(false)}
        onAddHost={handleAddHost}
      />

      {/* Minimal Footer */}
      <footer className="border-t border-neutral-800/60 py-3.5 px-6 text-center text-xs font-mono text-neutral-500 flex flex-col sm:flex-row items-center justify-between gap-2 max-w-7xl mx-auto w-full">
        <div className="flex items-center gap-2">
          <span>PulseMetrics v2.4</span>
          <span aria-hidden="true">·</span>
          <span>Linux Kernel Telemetry &amp; Remote SSH Pipe</span>
        </div>
        <div>
          <span>Shortcut: <code className="text-neutral-400">ssh work</code></span>
        </div>
      </footer>
    </div>
  );
}
