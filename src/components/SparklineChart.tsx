import React, { useState } from 'react';
import { HistoricalSeries } from '../types/metrics';
import { formatBitsPerSec } from '../utils/metrics-calculator';

interface SparklineChartProps {
  title: string;
  history: HistoricalSeries;
  metricKey: 'cpu' | 'memory' | 'downloadBps' | 'latencyMs';
  unit: string;
  color: string;
  height?: number;
}

export const SparklineChart: React.FC<SparklineChartProps> = ({
  title,
  history,
  metricKey,
  unit,
  color,
  height = 100,
}) => {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const values = history[metricKey] || [];
  if (values.length < 2) {
    return (
      <div className="flex flex-col p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl">
        <span className="text-xs text-neutral-400">{title}</span>
        <div className="flex items-center justify-center h-20 text-xs text-neutral-500 font-mono">
          Buffering telemetry stream...
        </div>
      </div>
    );
  }

  const width = 320;
  const padding = 10;
  const maxVal = metricKey === 'cpu' || metricKey === 'memory'
    ? 100
    : Math.max(...values, 10);
  const minVal = 0;

  const points = values.map((val, idx) => {
    const x = padding + (idx / (values.length - 1)) * (width - padding * 2);
    const y = height - padding - ((val - minVal) / (maxVal - minVal || 1)) * (height - padding * 2);
    return { x, y, val };
  });

  const pathD = points.reduce((acc, p, idx) => `${acc} ${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`, '');
  const areaD = `${pathD} L ${points[points.length - 1].x} ${height - padding} L ${points[0].x} ${height - padding} Z`;

  const latestVal = values[values.length - 1];
  const activeVal = hoverIndex !== null ? values[hoverIndex] : latestVal;

  const formattedActiveVal = metricKey === 'downloadBps'
    ? formatBitsPerSec(activeVal * 8)
    : `${(Math.round(activeVal * 10) / 10)} ${unit}`;

  return (
    <div className="flex flex-col p-3.5 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm hover:border-neutral-700 transition-all select-none">
      <div className="flex items-center justify-between text-xs text-neutral-400 font-medium mb-1.5">
        <span className="text-neutral-200">{title}</span>
        <span className="font-mono text-xs font-semibold tabular-nums" style={{ color }}>
          {formattedActiveVal}
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full overflow-visible"
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id={`grad-${metricKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Area fill */}
          <path d={areaD} fill={`url(#grad-${metricKey})`} />

          {/* Line stroke */}
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Hover hit targets */}
          {points.map((p, idx) => (
            <circle
              key={idx}
              cx={p.x}
              cy={p.y}
              r={hoverIndex === idx ? 4 : 2}
              fill={hoverIndex === idx ? '#ffffff' : color}
              stroke={color}
              strokeWidth="1.5"
              className="cursor-pointer transition-all"
              onMouseEnter={() => setHoverIndex(idx)}
            />
          ))}

          {/* Active pointer indicator */}
          {hoverIndex !== null && (
            <line
              x1={points[hoverIndex].x}
              y1={padding}
              x2={points[hoverIndex].x}
              y2={height - padding}
              stroke="#64748b"
              strokeDasharray="2 2"
              strokeWidth="1"
            />
          )}
        </svg>

        <div className="flex justify-between items-center text-[10px] text-neutral-500 font-mono mt-1">
          <span>30s ago</span>
          <span>Live</span>
        </div>
      </div>
    </div>
  );
};
