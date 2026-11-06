import React from 'react';
import { HostMetrics, WidgetLayoutConfig, HostThresholdConfig, DEFAULT_THRESHOLDS } from '../types/metrics';
import { formatDuration } from '../utils/metrics-calculator';
import { AnalogDial } from './AnalogDial';
import { DualBandwidthDial } from './DualBandwidthDial';
import { ConcentricMemoryGauge } from './ConcentricMemoryGauge';
import { LatencyGauge } from './LatencyGauge';
import { SpeedTestWidget } from './SpeedTestWidget';
import { DiskGauge } from './DiskGauge';
import { SparklineChart } from './SparklineChart';
import { ProcessTable } from './ProcessTable';
import { Terminal, Shield, Cpu, RefreshCw, Server, AlertCircle, TrendingUp, SlidersHorizontal } from 'lucide-react';

interface HostViewProps {
  host: HostMetrics;
  widgets: WidgetLayoutConfig[];
  viewMode: 'grid' | 'compact' | 'focus';
  thresholds?: HostThresholdConfig;
  onOpenTerminal: (host: HostMetrics) => void;
  onRunSpeedTest: (hostId: string) => void;
  onOpenHistory?: (host: HostMetrics) => void;
  onOpenThresholds?: (host: HostMetrics) => void;
  onReconnectSsh?: (hostId: string) => void;
}

export const HostView: React.FC<HostViewProps> = ({
  host,
  widgets,
  viewMode,
  thresholds = DEFAULT_THRESHOLDS,
  onOpenTerminal,
  onRunSpeedTest,
  onOpenHistory,
  onOpenThresholds,
}) => {
  const isSsh = host.connectionType === 'ssh';

  // Sort widgets according to user preference
  const visibleWidgets = [...widgets]
    .filter((w) => w.visible)
    .sort((a, b) => a.order - b.order);

  const renderWidget = (id: string) => {
    switch (id) {
      case 'cpu':
        return (
          <div key="cpu" className="flex flex-col gap-2">
            <AnalogDial
              title="CPU Processor Load"
              value={host.cpu.usagePercent}
              min={0}
              max={100}
              unit="%"
              warningThreshold={thresholds.cpu.warning}
              criticalThreshold={thresholds.cpu.critical}
              subtitle={`${host.cpu.cores} Cores · ${host.cpu.temperatureC}°C`}
            />

            {/* Per-Core mini bars */}
            {viewMode !== 'compact' && host.cpu.perCoreUsage.length > 0 && (
              <div className="p-3 bg-neutral-900/80 border border-neutral-800 rounded-xl">
                <div className="flex items-center justify-between text-[11px] text-neutral-400 font-mono mb-1.5">
                  <span className="flex items-center gap-1 text-neutral-300">
                    <Cpu className="w-3 h-3 text-cyan-400" />
                    Load Avg: {host.cpu.loadAverage.join(' · ')}
                  </span>
                  <span>{host.cpu.freqMhz ? `${host.cpu.freqMhz} MHz` : ''}</span>
                </div>
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-1">
                  {host.cpu.perCoreUsage.map((coreVal, idx) => (
                    <div key={idx} className="flex flex-col items-center">
                      <div className="w-full bg-neutral-800 h-8 rounded-xs overflow-hidden flex flex-col justify-end p-0.5">
                        <div
                          className={`w-full rounded-xs transition-all duration-300 ${
                            coreVal > 85 ? 'bg-rose-500' : coreVal > 60 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ height: `${coreVal}%` }}
                        />
                      </div>
                      <span className="text-[9px] font-mono text-neutral-500 mt-0.5">c{idx}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );

      case 'memory':
        return (
          <ConcentricMemoryGauge
            key="memory"
            totalBytes={host.memory.totalBytes}
            usedBytes={host.memory.usedBytes}
            freeBytes={host.memory.freeBytes}
            cachedBytes={host.memory.cachedBytes}
            usagePercent={host.memory.usagePercent}
            swapTotalBytes={host.memory.swapTotalBytes}
            swapUsedBytes={host.memory.swapUsedBytes}
            swapPercent={host.memory.swapPercent}
            warningThreshold={thresholds.memory.warning}
            criticalThreshold={thresholds.memory.critical}
          />
        );

      case 'bandwidth':
        return (
          <DualBandwidthDial
            key="bandwidth"
            downloadBps={host.network.downloadBps}
            uploadBps={host.network.uploadBps}
            totalReceivedBytes={host.network.totalReceivedBytes}
            totalSentBytes={host.network.totalSentBytes}
            interfaceName={host.network.interfaceName}
          />
        );

      case 'speedtest':
        return (
          <SpeedTestWidget
            key="speedtest"
            speed={host.networkSpeed}
            onRunTest={() => onRunSpeedTest(host.hostId)}
            hostName={host.name}
          />
        );

      case 'disk':
        return (
          <DiskGauge
            key="disk"
            disk={host.disk}
            warningThreshold={thresholds.disk.warning}
            criticalThreshold={thresholds.disk.critical}
          />
        );

      case 'latency':
        return (
          <LatencyGauge
            key="latency"
            latency={host.latency}
            health={host.connectionHealth}
            hostName={host.name}
          />
        );

      case 'charts':
        return (
          <div key="charts" className="col-span-full grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <SparklineChart
              title="CPU Load (Last 30s)"
              history={host.history}
              metricKey="cpu"
              unit="%"
              color="#10b981"
            />
            <SparklineChart
              title="Memory Utilization"
              history={host.history}
              metricKey="memory"
              unit="%"
              color="#3b82f6"
            />
            <SparklineChart
              title="Bandwidth Stream"
              history={host.history}
              metricKey="downloadBps"
              unit="bps"
              color="#06b6d4"
            />
            <SparklineChart
              title="Ping Latency Stream"
              history={host.history}
              metricKey="latencyMs"
              unit="ms"
              color="#a855f7"
            />
          </div>
        );

      case 'processes':
        return (
          <div key="processes" className="col-span-full">
            <ProcessTable processes={host.topProcesses} />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Host Meta Banner */}
      <div className="p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-start sm:items-center gap-3">
            <div className="p-2.5 rounded-xl bg-neutral-800 border border-neutral-700/60 text-emerald-400 shrink-0">
              <Server className="w-5 h-5" />
            </div>

            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-white tracking-tight">{host.name}</h2>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 border border-neutral-700/60">
                  {host.sshCommand}
                </span>
                <span
                  className={`text-[11px] font-mono px-2 py-0.5 rounded flex items-center gap-1 ${
                    host.connectionHealth.state === 'excellent'
                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                      : host.connectionHealth.state === 'good'
                      ? 'bg-blue-950 text-blue-400 border border-blue-800/60'
                      : 'bg-amber-950 text-amber-400 border border-amber-800/60'
                  }`}
                >
                  <Shield className="w-3 h-3" />
                  {host.connectionHealth.state.toUpperCase()}
                </span>
              </div>

              <div className="flex items-center gap-3 text-xs text-neutral-400 mt-1 flex-wrap font-mono">
                <span>{host.os.name} ({host.os.arch})</span>
                <span aria-hidden="true">·</span>
                <span>Kernel: {host.os.kernel}</span>
                <span aria-hidden="true">·</span>
                <span>Uptime: {formatDuration(host.uptimeSeconds)}</span>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 self-start lg:self-center">
            {onOpenThresholds && (
              <button
                onClick={() => onOpenThresholds(host)}
                aria-label={`Configure Thresholds for ${host.name}`}
                className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-mono flex items-center gap-1.5 border border-neutral-700 transition-all cursor-pointer"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-400" />
                <span>Thresholds</span>
              </button>
            )}
            {onOpenHistory && (
              <button
                onClick={() => onOpenHistory(host)}
                aria-label={`View Historical Performance and Anomalies for ${host.name}`}
                className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-mono flex items-center gap-1.5 border border-neutral-700 transition-all cursor-pointer"
              >
                <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
                <span>History &amp; Trends</span>
              </button>
            )}
            <button
              onClick={() => onOpenTerminal(host)}
              aria-label={`Open SSH Console for ${host.name}`}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-mono flex items-center gap-1.5 border border-neutral-700 transition-all cursor-pointer"
            >
              <Terminal className="w-3.5 h-3.5 text-emerald-400" />
              <span>SSH Console</span>
            </button>
          </div>
        </div>

        {/* Diagnostics message */}
        {host.connectionHealth.diagnosticsMessage && (
          <div className="mt-3 pt-2.5 border-t border-neutral-800/70 text-xs font-mono text-neutral-400 flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
            <span className="truncate">{host.connectionHealth.diagnosticsMessage}</span>
          </div>
        )}
      </div>

      {/* Primary Visual Dials & Gauges Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-4">
        {visibleWidgets.map((w) => renderWidget(w.id))}
      </div>
    </div>
  );
};
