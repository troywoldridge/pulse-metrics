import React from 'react';
import {
  formatBytes,
  clamp,
  describeArc,
  getSeverity,
  calculateThresholdBands,
} from '../utils/metrics-calculator';

interface ConcentricMemoryGaugeProps {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  cachedBytes: number;
  usagePercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapPercent: number;
  warningThreshold?: number;
  criticalThreshold?: number;
}

export const ConcentricMemoryGauge: React.FC<ConcentricMemoryGaugeProps> = ({
  totalBytes,
  usedBytes,
  freeBytes,
  cachedBytes,
  usagePercent,
  swapTotalBytes,
  swapUsedBytes,
  swapPercent,
  warningThreshold = 80,
  criticalThreshold = 92,
}) => {
  const size = 200;
  const center = size / 2;
  const ramRadius = 72;
  const swapRadius = 54;

  const startAngle = -135;
  const sweepAngle = 270;
  const endAngle = 135;

  const ramClamped = clamp(usagePercent, 0, 100);
  const ramEndAngle = startAngle + (ramClamped / 100) * sweepAngle;

  const swapClamped = clamp(swapPercent, 0, 100);
  const swapEndAngle = startAngle + (swapClamped / 100) * sweepAngle;

  const ramSeverity = getSeverity(ramClamped, warningThreshold, criticalThreshold);
  const ramColor =
    ramSeverity === 'critical' ? '#ef4444' : ramSeverity === 'warning' ? '#f59e0b' : '#3b82f6';

  const swapColor = swapClamped > 50 ? '#ef4444' : swapClamped > 20 ? '#f59e0b' : '#10b981';

  // RAM threshold colored bands on outer track
  const ramThresholdBands = calculateThresholdBands(
    center,
    ramRadius + 6,
    0,
    100,
    warningThreshold,
    criticalThreshold,
    startAngle,
    sweepAngle
  );

  return (
    <div className="flex flex-col p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl relative shadow-sm hover:border-neutral-700 transition-all select-none">
      <div className="flex items-center justify-between text-xs text-neutral-400 font-medium mb-1">
        <span className="tracking-wide text-neutral-200">Memory &amp; Swap</span>
        <span className="font-mono text-[11px] text-neutral-500">
          {formatBytes(usedBytes)} / {formatBytes(totalBytes)}
        </span>
      </div>

      <div className="relative flex justify-center items-center my-1">
        <svg width={size} height={size * 0.9} viewBox={`0 0 ${size} ${size}`}>
          {/* Outer RAM Threshold Bands */}
          {ramThresholdBands.map((band, idx) => (
            <path
              key={idx}
              d={band.arcPath}
              fill="none"
              stroke={band.color}
              strokeWidth="3.5"
              strokeLinecap="butt"
              opacity="0.65"
            />
          ))}

          {/* Outer RAM Base Arc */}
          <path
            d={describeArc(center, center, ramRadius, startAngle, endAngle)}
            fill="none"
            stroke="#1e293b"
            strokeWidth="8"
            strokeLinecap="round"
          />

          {/* Outer RAM Active Arc */}
          <path
            d={describeArc(center, center, ramRadius, startAngle, ramEndAngle > startAngle ? ramEndAngle : startAngle + 0.1)}
            fill="none"
            stroke={ramColor}
            strokeWidth="8"
            strokeLinecap="round"
            className="transition-all duration-300 ease-out"
          />

          {/* Inner Swap Base Arc */}
          <path
            d={describeArc(center, center, swapRadius, startAngle, endAngle)}
            fill="none"
            stroke="#1e293b"
            strokeWidth="5"
            strokeLinecap="round"
          />

          {/* Inner Swap Active Arc */}
          <path
            d={describeArc(center, center, swapRadius, startAngle, swapEndAngle > startAngle ? swapEndAngle : startAngle + 0.1)}
            fill="none"
            stroke={swapColor}
            strokeWidth="5"
            strokeLinecap="round"
            className="transition-all duration-300 ease-out"
          />

          {/* Scale markers */}
          <text x="32" y="172" fill="#64748b" fontSize="9" fontFamily="monospace">0%</text>
          <text x="168" y="172" fill="#64748b" fontSize="9" fontFamily="monospace" textAnchor="end">100%</text>
        </svg>

        {/* Center Readout */}
        <div className="absolute flex flex-col items-center justify-center pointer-events-none mt-2">
          <span
            className="text-2xl font-bold font-mono tabular-nums drop-shadow transition-colors"
            style={{ color: ramColor }}
          >
            {ramClamped}%
          </span>
          <span className="text-[10px] uppercase font-mono tracking-wider text-blue-400">
            RAM Used
          </span>
          <div className="flex items-center gap-1 text-[9px] font-mono text-neutral-400 mt-0.5">
            <span className="text-amber-400/90">W:{warningThreshold}%</span>
            <span>·</span>
            <span className="text-rose-400/90">C:{criticalThreshold}%</span>
          </div>
        </div>
      </div>

      {/* Breakdown strip */}
      <div className="grid grid-cols-3 gap-1 pt-2 border-t border-neutral-800 text-center font-mono">
        <div className="bg-neutral-800/40 p-1.5 rounded">
          <div className="text-[10px] text-neutral-400">Free</div>
          <div className="text-xs font-semibold text-neutral-200">{formatBytes(freeBytes)}</div>
        </div>
        <div className="bg-neutral-800/40 p-1.5 rounded">
          <div className="text-[10px] text-neutral-400">Cached</div>
          <div className="text-xs font-semibold text-neutral-200">{formatBytes(cachedBytes)}</div>
        </div>
        <div className="bg-neutral-800/40 p-1.5 rounded">
          <div className="text-[10px] text-neutral-400">Swap ({swapClamped}%)</div>
          <div className="text-xs font-semibold text-neutral-200">{formatBytes(swapUsedBytes)}</div>
        </div>
      </div>
    </div>
  );
};
