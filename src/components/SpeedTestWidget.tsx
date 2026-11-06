import React from 'react';
import { InternetSpeedMetrics } from '../types/metrics';
import { Wifi, Play, RefreshCw, ArrowDown, ArrowUp } from 'lucide-react';

interface SpeedTestWidgetProps {
  speed: InternetSpeedMetrics;
  onRunTest: () => void;
  hostName: string;
}

export const SpeedTestWidget: React.FC<SpeedTestWidgetProps> = ({
  speed,
  onRunTest,
  hostName,
}) => {
  const isTesting = speed.status === 'testing';

  return (
    <div className="flex flex-col p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl relative shadow-sm hover:border-neutral-700 transition-all">
      <div className="flex items-center justify-between text-xs text-neutral-400 font-medium mb-3">
        <div className="flex items-center gap-1.5 text-neutral-200">
          <Wifi className="w-3.5 h-3.5 text-cyan-400" />
          <span>Internet Speed &amp; Quality</span>
        </div>
        <button
          onClick={onRunTest}
          disabled={isTesting}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-cyan-600 hover:bg-cyan-500 active:scale-95 text-white transition-all disabled:opacity-50 cursor-pointer"
          aria-label={`Run Speed Test for ${hostName}`}
        >
          {isTesting ? (
            <>
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>Testing...</span>
            </>
          ) : (
            <>
              <Play className="w-3 h-3 fill-current" />
              <span>Run Speed Test</span>
            </>
          )}
        </button>
      </div>

      {/* Speed Readouts */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Download Speed */}
        <div className="p-3 bg-neutral-800/50 rounded-lg border border-neutral-700/50 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-neutral-400 mb-1">
            <span className="flex items-center gap-1">
              <ArrowDown className="w-3.5 h-3.5 text-cyan-400" />
              Download
            </span>
            <span className="text-[10px] font-mono text-cyan-400">Mbps</span>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-white tracking-tight">
            {isTesting ? (
              <span className="animate-pulse text-cyan-400">Testing...</span>
            ) : (
              speed.downloadSpeedMbps.toFixed(1)
            )}
          </div>
          <div className="w-full bg-neutral-700/50 h-1.5 rounded-full mt-2 overflow-hidden">
            <div
              className="bg-cyan-400 h-full rounded-full transition-all duration-700"
              style={{ width: `${Math.min(100, (speed.downloadSpeedMbps / 1000) * 100)}%` }}
            />
          </div>
        </div>

        {/* Upload Speed */}
        <div className="p-3 bg-neutral-800/50 rounded-lg border border-neutral-700/50 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-neutral-400 mb-1">
            <span className="flex items-center gap-1">
              <ArrowUp className="w-3.5 h-3.5 text-purple-400" />
              Upload
            </span>
            <span className="text-[10px] font-mono text-purple-400">Mbps</span>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-white tracking-tight">
            {isTesting ? (
              <span className="animate-pulse text-purple-400">Testing...</span>
            ) : (
              speed.uploadSpeedMbps.toFixed(1)
            )}
          </div>
          <div className="w-full bg-neutral-700/50 h-1.5 rounded-full mt-2 overflow-hidden">
            <div
              className="bg-purple-400 h-full rounded-full transition-all duration-700"
              style={{ width: `${Math.min(100, (speed.uploadSpeedMbps / 500) * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Latency & Jitter metrics */}
      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-neutral-800 text-center font-mono">
        <div className="bg-neutral-800/40 p-1.5 rounded">
          <div className="text-[10px] text-neutral-400">Ping</div>
          <div className="text-xs font-semibold text-emerald-400 tabular-nums">
            {speed.pingMs} ms
          </div>
        </div>
        <div className="bg-neutral-800/40 p-1.5 rounded">
          <div className="text-[10px] text-neutral-400">Jitter</div>
          <div className="text-xs font-semibold text-neutral-200 tabular-nums">
            {speed.jitterMs} ms
          </div>
        </div>
        <div className="bg-neutral-800/40 p-1.5 rounded">
          <div className="text-[10px] text-neutral-400">Packet Loss</div>
          <div className="text-xs font-semibold text-neutral-200 tabular-nums">
            {speed.packetLossPercent}%
          </div>
        </div>
      </div>

      {speed.lastTested && (
        <div className="mt-2 text-right text-[10px] text-neutral-500 font-mono">
          Last tested: {new Date(speed.lastTested).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
};
