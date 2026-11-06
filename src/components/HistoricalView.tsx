import React, { useState, useEffect } from 'react';
import {
  HistoricalDataPoint,
  TimeRangeOption,
  HostMetrics,
  HostThresholdConfig,
  DEFAULT_THRESHOLDS,
} from '../types/metrics';
import { HistoricalChart } from './HistoricalChart';
import { detectAnomalies, AnomalyPoint } from '../utils/anomaly-detector';
import {
  Clock,
  TrendingUp,
  AlertTriangle,
  Sliders,
  Filter,
  CheckCircle2,
  Calendar,
  Layers,
  ArrowRight,
  SlidersHorizontal,
} from 'lucide-react';

interface HistoricalViewProps {
  host: HostMetrics;
  thresholds?: HostThresholdConfig;
  onOpenThresholds?: (host: HostMetrics) => void;
  onClose?: () => void;
  wsSocket?: WebSocket | null;
}

export const HistoricalView: React.FC<HistoricalViewProps> = ({
  host,
  thresholds = DEFAULT_THRESHOLDS,
  onOpenThresholds,
  wsSocket,
}) => {
  const [timeRange, setTimeRange] = useState<TimeRangeOption>('1h');
  const [selectedMetric, setSelectedMetric] = useState<'all' | 'cpu' | 'memory' | 'network' | 'disk'>('all');
  const [showTrendLine, setShowTrendLine] = useState<boolean>(true);
  const [showAnomalies, setShowAnomalies] = useState<boolean>(true);
  const [sensitivity, setSensitivity] = useState<number>(2.2); // 1.8 = high sensitivity, 3.0 = low

  const [historyData, setHistoryData] = useState<HistoricalDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedAnomaly, setSelectedAnomaly] = useState<AnomalyPoint | null>(null);

  // Fetch historical data on mount, host change, or time range change
  useEffect(() => {
    let isCancelled = false;
    setIsLoading(true);

    fetch(`/api/history?hostId=${host.hostId}&range=${timeRange}`)
      .then((res) => res.json())
      .then((json) => {
        if (!isCancelled && json.points) {
          setHistoryData(json.points);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch historical telemetry:', err);
      })
      .finally(() => {
        if (!isCancelled) setIsLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [host.hostId, timeRange]);

  // Aggregate all anomalies across the 4 primary metrics
  const cpuPoints = historyData.map((d) => ({ timestamp: d.timestamp, value: d.cpu }));
  const memPoints = historyData.map((d) => ({ timestamp: d.timestamp, value: d.memory }));
  const netDlPoints = historyData.map((d) => ({ timestamp: d.timestamp, value: d.downloadMbps }));
  const netUlPoints = historyData.map((d) => ({ timestamp: d.timestamp, value: d.uploadMbps }));
  const diskIoPoints = historyData.map((d) => ({ timestamp: d.timestamp, value: d.diskIoMbps }));
  const diskUsagePoints = historyData.map((d) => ({ timestamp: d.timestamp, value: d.diskUsage }));

  const cpuAnomalies = detectAnomalies(cpuPoints, { thresholdSigma: sensitivity, metricName: 'CPU', unit: '%' });
  const memAnomalies = detectAnomalies(memPoints, { thresholdSigma: sensitivity, metricName: 'RAM', unit: '%' });
  const netAnomalies = detectAnomalies(netDlPoints, { thresholdSigma: sensitivity, metricName: 'Download', unit: ' Mbps' });
  const diskAnomalies = detectAnomalies(diskIoPoints, { thresholdSigma: sensitivity, metricName: 'Disk I/O', unit: ' MB/s' });

  const allAnomalies = [...cpuAnomalies, ...memAnomalies, ...netAnomalies, ...diskAnomalies].sort(
    (a, b) => b.timestamp - a.timestamp
  );

  const timeRangeLabels: Record<TimeRangeOption, string> = {
    '15m': 'Last 15 Minutes',
    '1h': 'Last 1 Hour',
    '24h': 'Last 24 Hours',
    '7d': 'Last 7 Days',
  };

  return (
    <div className="flex flex-col gap-5 p-5 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-2xl shadow-sm">
      {/* Historical Header & Filter Toolbar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-neutral-800">
        <div>
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-bold text-white tracking-tight">
              Historical Performance &amp; Anomaly Analytics
            </h2>
            <span className="text-xs px-2.5 py-0.5 rounded font-mono bg-neutral-800 text-neutral-300 border border-neutral-700/60">
              {host.name}
            </span>
          </div>
          <p className="text-xs text-neutral-400 font-mono mt-1">
            Analyzing telemetry trend lines, regression slopes, and rolling Z-score anomaly outliers.
          </p>
        </div>

        {/* Action Controls & Time Range Selector Buttons */}
        <div className="flex flex-wrap items-center gap-2 self-start lg:self-center">
          {onOpenThresholds && (
            <button
              onClick={() => onOpenThresholds(host)}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-mono flex items-center gap-1.5 border border-neutral-700 transition-all cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-400" />
              <span>Configure Thresholds</span>
            </button>
          )}
          <div className="flex items-center gap-1.5 bg-neutral-950 p-1 rounded-xl border border-neutral-800">
            {(['15m', '1h', '24h', '7d'] as TimeRangeOption[]).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1.5 text-xs font-mono font-medium rounded-lg transition-all cursor-pointer ${
                  timeRange === range
                    ? 'bg-cyan-600 text-white shadow-xs'
                    : 'text-neutral-400 hover:text-white hover:bg-neutral-800/60'
                }`}
              >
                {range.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Analysis Controls & Toggles Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        {/* Metric Tabs */}
        <div className="flex items-center gap-1 bg-neutral-950 p-1 rounded-lg border border-neutral-800 overflow-x-auto">
          {[
            { id: 'all', label: 'All Metrics' },
            { id: 'cpu', label: 'CPU Load' },
            { id: 'memory', label: 'Memory' },
            { id: 'network', label: 'Network' },
            { id: 'disk', label: 'Disk I/O' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setSelectedMetric(tab.id as any)}
              className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap cursor-pointer ${
                selectedMetric === tab.id
                  ? 'bg-neutral-800 text-cyan-300 font-semibold shadow-xs'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Feature Toggles */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-neutral-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showTrendLine}
              onChange={(e) => setShowTrendLine(e.target.checked)}
              className="rounded accent-cyan-500 cursor-pointer"
            />
            <span className="flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
              <span>Trend Lines</span>
            </span>
          </label>

          <label className="flex items-center gap-1.5 text-neutral-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showAnomalies}
              onChange={(e) => setShowAnomalies(e.target.checked)}
              className="rounded accent-rose-500 cursor-pointer"
            />
            <span className="flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              <span>Anomaly Detection</span>
            </span>
          </label>

          {/* Sensitivity preset */}
          <div className="flex items-center gap-1 text-neutral-400">
            <Sliders className="w-3.5 h-3.5 text-neutral-500" />
            <select
              value={sensitivity}
              onChange={(e) => setSensitivity(parseFloat(e.target.value))}
              className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-[11px] text-neutral-300 focus:outline-none focus:border-cyan-500"
            >
              <option value="1.8">Strict (1.8σ)</option>
              <option value="2.2">Balanced (2.2σ)</option>
              <option value="3.0">Tolerant (3.0σ)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Anomaly Health Overview Alert Card */}
      <div
        className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
          allAnomalies.length > 0
            ? 'bg-rose-950/20 border-rose-900/40 text-rose-200'
            : 'bg-emerald-950/20 border-emerald-900/40 text-emerald-200'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`p-2 rounded-lg ${
              allAnomalies.length > 0 ? 'bg-rose-900/40 text-rose-400' : 'bg-emerald-900/40 text-emerald-400'
            }`}
          >
            {allAnomalies.length > 0 ? (
              <AlertTriangle className="w-4 h-4" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
          </div>
          <div>
            <div className="font-semibold text-xs text-white">
              {allAnomalies.length > 0
                ? `${allAnomalies.length} Performance Anomalies Detected (${timeRangeLabels[timeRange]})`
                : `Nominal Baseline: No Anomalies Detected in ${timeRangeLabels[timeRange]}`}
            </div>
            <div className="text-[11px] font-mono text-neutral-400 mt-0.5">
              {allAnomalies.length > 0
                ? `Statistical departures exceeding ${sensitivity}σ standard deviations from the rolling baseline window.`
                : 'All performance metrics stayed comfortably within statistical tolerance bounds.'}
            </div>
          </div>
        </div>

        <div className="text-right text-[11px] font-mono text-neutral-400 shrink-0">
          Resolution: {historyData.length} samples ({timeRange})
        </div>
      </div>

      {/* Historical Visual Charts Grid */}
      {isLoading ? (
        <div className="p-16 text-center text-xs font-mono text-neutral-500">
          Aggregating historical log series...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(selectedMetric === 'all' || selectedMetric === 'cpu') && (
            <HistoricalChart
              title="CPU Processor Utilization (%)"
              points={cpuPoints}
              metricName="CPU"
              unit="%"
              color="#10b981"
              showTrendLine={showTrendLine}
              showAnomalies={showAnomalies}
              warningThreshold={thresholds.cpu.warning}
              criticalThreshold={thresholds.cpu.critical}
              anomalySensitivity={sensitivity}
              onSelectAnomaly={(a) => setSelectedAnomaly(a)}
            />
          )}

          {(selectedMetric === 'all' || selectedMetric === 'memory') && (
            <HistoricalChart
              title="Memory Utilization (%)"
              points={memPoints}
              metricName="RAM"
              unit="%"
              color="#3b82f6"
              showTrendLine={showTrendLine}
              showAnomalies={showAnomalies}
              warningThreshold={thresholds.memory.warning}
              criticalThreshold={thresholds.memory.critical}
              anomalySensitivity={sensitivity}
              onSelectAnomaly={(a) => setSelectedAnomaly(a)}
            />
          )}

          {(selectedMetric === 'all' || selectedMetric === 'disk') && (
            <HistoricalChart
              title="Disk Storage Utilization (%)"
              points={diskUsagePoints}
              metricName="Disk Usage"
              unit="%"
              color="#f59e0b"
              showTrendLine={showTrendLine}
              showAnomalies={showAnomalies}
              warningThreshold={thresholds.disk.warning}
              criticalThreshold={thresholds.disk.critical}
              anomalySensitivity={sensitivity}
              onSelectAnomaly={(a) => setSelectedAnomaly(a)}
            />
          )}

          {(selectedMetric === 'all' || selectedMetric === 'network') && (
            <HistoricalChart
              title="Network Ingress Bandwidth (Mbps)"
              points={netDlPoints}
              metricName="Download"
              unit=" Mbps"
              color="#06b6d4"
              showTrendLine={showTrendLine}
              showAnomalies={showAnomalies}
              anomalySensitivity={sensitivity}
              onSelectAnomaly={(a) => setSelectedAnomaly(a)}
            />
          )}

          {selectedMetric === 'disk' && (
            <HistoricalChart
              title="Disk I/O Throughput (MB/s)"
              points={diskIoPoints}
              metricName="Disk I/O"
              unit=" MB/s"
              color="#f97316"
              showTrendLine={showTrendLine}
              showAnomalies={showAnomalies}
              anomalySensitivity={sensitivity}
              onSelectAnomaly={(a) => setSelectedAnomaly(a)}
            />
          )}
        </div>
      )}

      {/* Detected Anomalies Incident Feed */}
      {allAnomalies.length > 0 && showAnomalies && (
        <div className="mt-2 p-4 bg-neutral-950/70 border border-neutral-800 rounded-xl">
          <div className="flex items-center justify-between mb-3 text-xs">
            <div className="flex items-center gap-1.5 text-neutral-200 font-semibold">
              <Layers className="w-3.5 h-3.5 text-rose-400" />
              <span>Anomaly Incident Log ({allAnomalies.length})</span>
            </div>
            <span className="text-[11px] font-mono text-neutral-500">
              Sorted by recency · {timeRangeLabels[timeRange]}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[11px] tabular-nums">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-400 text-[10px] uppercase">
                  <th className="pb-1.5 font-medium">Timestamp</th>
                  <th className="pb-1.5 font-medium">Metric</th>
                  <th className="pb-1.5 font-medium">Severity</th>
                  <th className="pb-1.5 font-medium text-right">Value</th>
                  <th className="pb-1.5 font-medium text-right">Baseline</th>
                  <th className="pb-1.5 font-medium text-right">Deviation</th>
                  <th className="pb-1.5 font-medium pl-4">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-900">
                {allAnomalies.slice(0, 8).map((anomaly, idx) => (
                  <tr
                    key={idx}
                    onClick={() => setSelectedAnomaly(anomaly)}
                    className="hover:bg-neutral-900/60 cursor-pointer transition-colors"
                  >
                    <td className="py-2 text-neutral-400 whitespace-nowrap">
                      {new Date(anomaly.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2 font-medium text-neutral-200">
                      {anomaly.description.split(' ')[0]}
                    </td>
                    <td className="py-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${
                          anomaly.severity === 'high'
                            ? 'bg-rose-950 text-rose-400 border border-rose-800/60'
                            : anomaly.severity === 'medium'
                            ? 'bg-amber-950 text-amber-400 border border-amber-800/60'
                            : 'bg-neutral-800 text-neutral-400'
                        }`}
                      >
                        {anomaly.severity}
                      </span>
                    </td>
                    <td className="py-2 text-right font-bold text-rose-300">
                      {typeof anomaly.value === 'number' ? (Math.round(anomaly.value * 10) / 10).toFixed(1) : anomaly.value}
                    </td>
                    <td className="py-2 text-right text-neutral-400">
                      {typeof anomaly.expectedValue === 'number' ? (Math.round(anomaly.expectedValue * 10) / 10).toFixed(1) : anomaly.expectedValue}
                    </td>
                    <td className="py-2 text-right text-amber-400 font-semibold">
                      +{anomaly.deviationSigma}σ
                    </td>
                    <td className="py-2 pl-4 text-neutral-300 truncate max-w-[280px]">
                      {anomaly.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
