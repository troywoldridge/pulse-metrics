import React from 'react';
import { HostDiskMetrics } from '../types/metrics';
import { formatBytes } from '../utils/metrics-calculator';
import { HardDrive, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { AnalogDial } from './AnalogDial';

interface DiskGaugeProps {
  disk: HostDiskMetrics;
  warningThreshold?: number;
  criticalThreshold?: number;
}

export const DiskGauge: React.FC<DiskGaugeProps> = ({
  disk,
  warningThreshold = 85,
  criticalThreshold = 95,
}) => {
  return (
    <div className="flex flex-col p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl relative shadow-sm hover:border-neutral-700 transition-all">
      <div className="flex items-center justify-between text-xs text-neutral-400 font-medium mb-1">
        <div className="flex items-center gap-1.5 text-neutral-200">
          <HardDrive className="w-3.5 h-3.5 text-orange-400" />
          <span>Storage &amp; Disk I/O</span>
        </div>
        <span className="font-mono text-[11px] text-neutral-500">{disk.mountPoint}</span>
      </div>

      <div className="flex items-center justify-center">
        <AnalogDial
          title=""
          value={disk.usagePercent}
          min={0}
          max={100}
          unit="%"
          warningThreshold={warningThreshold}
          criticalThreshold={criticalThreshold}
          size={180}
          subtitle={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`}
        />
      </div>

      {/* Disk Read & Write I/O Speeds */}
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-neutral-800 text-center font-mono">
        <div className="flex items-center justify-center gap-1.5 bg-neutral-800/40 p-1.5 rounded">
          <ArrowDownToLine className="w-3.5 h-3.5 text-blue-400" />
          <div className="text-left">
            <div className="text-[10px] text-neutral-400">Disk Read</div>
            <div className="text-xs font-semibold text-neutral-200 tabular-nums">
              {formatBytes(disk.readSpeedBps)}/s
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center gap-1.5 bg-neutral-800/40 p-1.5 rounded">
          <ArrowUpFromLine className="w-3.5 h-3.5 text-orange-400" />
          <div className="text-left">
            <div className="text-[10px] text-neutral-400">Disk Write</div>
            <div className="text-xs font-semibold text-neutral-200 tabular-nums">
              {formatBytes(disk.writeSpeedBps)}/s
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
