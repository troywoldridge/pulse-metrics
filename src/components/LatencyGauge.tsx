import React from 'react';
import { HostLatencyMetrics, ConnectionHealth } from '../types/metrics';
import { AnalogDial } from './AnalogDial';
import { Activity, ShieldCheck, AlertTriangle } from 'lucide-react';

interface LatencyGaugeProps {
  latency: HostLatencyMetrics;
  health: ConnectionHealth;
  hostName: string;
}

export const LatencyGauge: React.FC<LatencyGaugeProps> = ({ latency, health, hostName }) => {
  const isHealthy = health.state === 'excellent' || health.state === 'good';

  return (
    <div className="flex flex-col p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl relative shadow-sm hover:border-neutral-700 transition-all">
      <div className="flex items-center justify-between text-xs text-neutral-400 font-medium mb-1">
        <div className="flex items-center gap-1.5 text-neutral-200">
          <Activity className="w-3.5 h-3.5 text-emerald-400" />
          <span>Latency &amp; Connection</span>
        </div>
        <div className="flex items-center gap-1">
          {isHealthy ? (
            <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              {health.state.toUpperCase()}
            </span>
          ) : (
            <span className="text-[11px] font-mono text-amber-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              {health.state.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center">
        <AnalogDial
          title=""
          value={latency.currentMs}
          min={0}
          max={120}
          unit="ms"
          warningThreshold={50}
          criticalThreshold={90}
          size={180}
          subtitle={`Avg: ${latency.avgMs}ms`}
        />
      </div>

      {/* Latency stats breakdown */}
      <div className="grid grid-cols-3 gap-1.5 pt-2 border-t border-neutral-800 text-center font-mono">
        <div className="bg-neutral-800/40 p-1 rounded">
          <div className="text-[10px] text-neutral-400">Jitter</div>
          <div className="text-xs font-semibold text-neutral-200">{latency.jitterMs} ms</div>
        </div>
        <div className="bg-neutral-800/40 p-1 rounded">
          <div className="text-[10px] text-neutral-400">Packet Loss</div>
          <div className="text-xs font-semibold text-neutral-200">{latency.packetLossPercent}%</div>
        </div>
        <div className="bg-neutral-800/40 p-1 rounded">
          <div className="text-[10px] text-neutral-400">Min / Max</div>
          <div className="text-xs font-semibold text-neutral-200">{latency.minMs}/{latency.maxMs}</div>
        </div>
      </div>
    </div>
  );
};
