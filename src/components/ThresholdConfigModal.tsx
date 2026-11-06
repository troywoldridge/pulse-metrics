import React, { useState } from 'react';
import { HostThresholdConfig, HostThresholdMap, DEFAULT_THRESHOLDS } from '../types/metrics';
import { AnalogDial } from './AnalogDial';
import { X, SlidersHorizontal, RotateCcw, Check, Server, Cpu, HardDrive, Database, ShieldAlert } from 'lucide-react';

interface ThresholdConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  hosts: { hostId: string; name: string }[];
  currentThresholds: HostThresholdMap;
  onSaveThresholds: (newMap: HostThresholdMap) => void;
  initialSelectedHostId?: string;
}

export const ThresholdConfigModal: React.FC<ThresholdConfigModalProps> = ({
  isOpen,
  onClose,
  hosts,
  currentThresholds,
  onSaveThresholds,
  initialSelectedHostId,
}) => {
  const [selectedHostId, setSelectedHostId] = useState<string>(
    initialSelectedHostId || hosts[0]?.hostId || 'linux-pc'
  );

  const [thresholdsMap, setThresholdsMap] = useState<HostThresholdMap>(() => {
    const initial: HostThresholdMap = { ...currentThresholds };
    // Ensure all hosts have entries
    hosts.forEach((h) => {
      if (!initial[h.hostId]) {
        initial[h.hostId] = { ...DEFAULT_THRESHOLDS };
      }
    });
    return initial;
  });

  const [hasChanges, setHasChanges] = useState<boolean>(false);

  if (!isOpen) return null;

  const currentHostConfig: HostThresholdConfig =
    thresholdsMap[selectedHostId] || DEFAULT_THRESHOLDS;

  const handleUpdate = (
    metric: 'cpu' | 'memory' | 'disk',
    type: 'warning' | 'critical',
    value: number
  ) => {
    const clamped = Math.max(1, Math.min(99, Math.round(value)));
    const existing = currentHostConfig[metric];

    let newWarn = existing.warning;
    let newCrit = existing.critical;

    if (type === 'warning') {
      newWarn = clamped;
      if (newWarn >= newCrit) {
        newCrit = Math.min(100, newWarn + 5);
      }
    } else {
      newCrit = clamped;
      if (newCrit <= newWarn) {
        newWarn = Math.max(0, newCrit - 5);
      }
    }

    setThresholdsMap((prev) => ({
      ...prev,
      [selectedHostId]: {
        ...currentHostConfig,
        [metric]: {
          warning: newWarn,
          critical: newCrit,
        },
      },
    }));
    setHasChanges(true);
  };

  const handleResetCurrentHost = () => {
    setThresholdsMap((prev) => ({
      ...prev,
      [selectedHostId]: { ...DEFAULT_THRESHOLDS },
    }));
    setHasChanges(true);
  };

  const handleApply = () => {
    onSaveThresholds(thresholdsMap);
    setHasChanges(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-4xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-900/90">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-950/60 border border-cyan-800/60 text-cyan-400">
              <SlidersHorizontal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">
                Thresholds &amp; Alert Zones Configuration
              </h2>
              <p className="text-xs text-neutral-400 font-mono mt-0.5">
                Set custom Warning &amp; Critical percentage thresholds rendered on dials and historical charts.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
            aria-label="Close Threshold Modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Host Selector Navigation Bar */}
        <div className="flex items-center gap-2 px-6 py-2.5 bg-neutral-950 border-b border-neutral-800 overflow-x-auto text-xs font-mono">
          <span className="text-neutral-500 flex items-center gap-1 shrink-0 mr-1">
            <Server className="w-3.5 h-3.5" />
            Target Host:
          </span>
          {hosts.map((h) => {
            const isSelected = selectedHostId === h.hostId;
            return (
              <button
                key={h.hostId}
                onClick={() => setSelectedHostId(h.hostId)}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all whitespace-nowrap cursor-pointer flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-700/80 shadow-xs'
                    : 'text-neutral-400 hover:text-white hover:bg-neutral-800/60 border border-transparent'
                }`}
              >
                <span>{h.name}</span>
              </button>
            );
          })}
        </div>

        {/* Main Configuration Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Information Banner */}
          <div className="p-3.5 rounded-xl bg-neutral-950/80 border border-neutral-800 flex items-start gap-3 text-xs font-mono">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1 text-neutral-300">
              <div className="font-semibold text-white">
                Active Target: {hosts.find((h) => h.hostId === selectedHostId)?.name}
              </div>
              <div className="text-[11px] text-neutral-400 leading-relaxed">
                Thresholds configure colored alert zones on the analog dials (Emerald = Normal, Amber = Warning, Rose = Critical) and project horizontal reference threshold lines onto historical performance charts.
              </div>
            </div>
          </div>

          {/* Metric Threshold Controls Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* CPU Metric Config */}
            <div className="p-4 bg-neutral-950/60 border border-neutral-800/90 rounded-xl flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Cpu className="w-4 h-4 text-emerald-400" />
                    <span>CPU Load</span>
                  </div>
                  <span className="text-[10px] font-mono text-neutral-500 uppercase">Unit: %</span>
                </div>

                <div className="mt-4 space-y-4 font-mono">
                  {/* Warning Slider */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-amber-400 font-medium flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        Warning Threshold
                      </span>
                      <span className="text-white font-bold tabular-nums">
                        {currentHostConfig.cpu.warning}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="95"
                      value={currentHostConfig.cpu.warning}
                      onChange={(e) => handleUpdate('cpu', 'warning', parseInt(e.target.value))}
                      className="w-full accent-amber-500 bg-neutral-800 rounded-lg cursor-pointer h-1.5"
                    />
                    <div className="flex justify-between text-[10px] text-neutral-500 mt-0.5">
                      <span>10%</span>
                      <span>Default: 75%</span>
                      <span>95%</span>
                    </div>
                  </div>

                  {/* Critical Slider */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-rose-400 font-medium flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-rose-500" />
                        Critical Threshold
                      </span>
                      <span className="text-white font-bold tabular-nums">
                        {currentHostConfig.cpu.critical}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="20"
                      max="99"
                      value={currentHostConfig.cpu.critical}
                      onChange={(e) => handleUpdate('cpu', 'critical', parseInt(e.target.value))}
                      className="w-full accent-rose-500 bg-neutral-800 rounded-lg cursor-pointer h-1.5"
                    />
                    <div className="flex justify-between text-[10px] text-neutral-500 mt-0.5">
                      <span>20%</span>
                      <span>Default: 90%</span>
                      <span>99%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Mini Preview Dial */}
              <div className="pt-3 border-t border-neutral-800/80 flex flex-col items-center">
                <span className="text-[10px] uppercase font-mono text-neutral-500 mb-1">Live Gauge Preview</span>
                <AnalogDial
                  title="CPU Preview"
                  value={currentHostConfig.cpu.warning + 5}
                  min={0}
                  max={100}
                  unit="%"
                  warningThreshold={currentHostConfig.cpu.warning}
                  criticalThreshold={currentHostConfig.cpu.critical}
                  size={140}
                  subtitle="Sample Load"
                />
              </div>
            </div>

            {/* Memory Metric Config */}
            <div className="p-4 bg-neutral-950/60 border border-neutral-800/90 rounded-xl flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Database className="w-4 h-4 text-blue-400" />
                    <span>Memory (RAM)</span>
                  </div>
                  <span className="text-[10px] font-mono text-neutral-500 uppercase">Unit: %</span>
                </div>

                <div className="mt-4 space-y-4 font-mono">
                  {/* Warning Slider */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-amber-400 font-medium flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        Warning Threshold
                      </span>
                      <span className="text-white font-bold tabular-nums">
                        {currentHostConfig.memory.warning}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="95"
                      value={currentHostConfig.memory.warning}
                      onChange={(e) => handleUpdate('memory', 'warning', parseInt(e.target.value))}
                      className="w-full accent-amber-500 bg-neutral-800 rounded-lg cursor-pointer h-1.5"
                    />
                    <div className="flex justify-between text-[10px] text-neutral-500 mt-0.5">
                      <span>10%</span>
                      <span>Default: 80%</span>
                      <span>95%</span>
                    </div>
                  </div>

                  {/* Critical Slider */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-rose-400 font-medium flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-rose-500" />
                        Critical Threshold
                      </span>
                      <span className="text-white font-bold tabular-nums">
                        {currentHostConfig.memory.critical}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="20"
                      max="99"
                      value={currentHostConfig.memory.critical}
                      onChange={(e) => handleUpdate('memory', 'critical', parseInt(e.target.value))}
                      className="w-full accent-rose-500 bg-neutral-800 rounded-lg cursor-pointer h-1.5"
                    />
                    <div className="flex justify-between text-[10px] text-neutral-500 mt-0.5">
                      <span>20%</span>
                      <span>Default: 92%</span>
                      <span>99%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Mini Preview Dial */}
              <div className="pt-3 border-t border-neutral-800/80 flex flex-col items-center">
                <span className="text-[10px] uppercase font-mono text-neutral-500 mb-1">Live Gauge Preview</span>
                <AnalogDial
                  title="RAM Preview"
                  value={currentHostConfig.memory.warning - 10}
                  min={0}
                  max={100}
                  unit="%"
                  warningThreshold={currentHostConfig.memory.warning}
                  criticalThreshold={currentHostConfig.memory.critical}
                  size={140}
                  subtitle="Sample RAM"
                />
              </div>
            </div>

            {/* Disk Metric Config */}
            <div className="p-4 bg-neutral-950/60 border border-neutral-800/90 rounded-xl flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <HardDrive className="w-4 h-4 text-orange-400" />
                    <span>Disk Storage</span>
                  </div>
                  <span className="text-[10px] font-mono text-neutral-500 uppercase">Unit: %</span>
                </div>

                <div className="mt-4 space-y-4 font-mono">
                  {/* Warning Slider */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-amber-400 font-medium flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        Warning Threshold
                      </span>
                      <span className="text-white font-bold tabular-nums">
                        {currentHostConfig.disk.warning}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="95"
                      value={currentHostConfig.disk.warning}
                      onChange={(e) => handleUpdate('disk', 'warning', parseInt(e.target.value))}
                      className="w-full accent-amber-500 bg-neutral-800 rounded-lg cursor-pointer h-1.5"
                    />
                    <div className="flex justify-between text-[10px] text-neutral-500 mt-0.5">
                      <span>10%</span>
                      <span>Default: 85%</span>
                      <span>95%</span>
                    </div>
                  </div>

                  {/* Critical Slider */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-rose-400 font-medium flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-rose-500" />
                        Critical Threshold
                      </span>
                      <span className="text-white font-bold tabular-nums">
                        {currentHostConfig.disk.critical}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="20"
                      max="99"
                      value={currentHostConfig.disk.critical}
                      onChange={(e) => handleUpdate('disk', 'critical', parseInt(e.target.value))}
                      className="w-full accent-rose-500 bg-neutral-800 rounded-lg cursor-pointer h-1.5"
                    />
                    <div className="flex justify-between text-[10px] text-neutral-500 mt-0.5">
                      <span>20%</span>
                      <span>Default: 95%</span>
                      <span>99%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Mini Preview Dial */}
              <div className="pt-3 border-t border-neutral-800/80 flex flex-col items-center">
                <span className="text-[10px] uppercase font-mono text-neutral-500 mb-1">Live Gauge Preview</span>
                <AnalogDial
                  title="Disk Preview"
                  value={currentHostConfig.disk.critical + 2}
                  min={0}
                  max={100}
                  unit="%"
                  warningThreshold={currentHostConfig.disk.warning}
                  criticalThreshold={currentHostConfig.disk.critical}
                  size={140}
                  subtitle="Sample Disk"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-neutral-800 bg-neutral-900/90 text-xs font-mono">
          <button
            onClick={handleResetCurrentHost}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer border border-neutral-800"
          >
            <RotateCcw className="w-3.5 h-3.5 text-neutral-400" />
            <span>Reset {hosts.find((h) => h.hostId === selectedHostId)?.name} to Defaults</span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-all shadow-xs cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>Save &amp; Apply Thresholds</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
