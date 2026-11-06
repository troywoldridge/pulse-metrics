import React, { useState } from 'react';
import { TimeSeriesPoint, calculateTrendLine, detectAnomalies, AnomalyPoint } from '../utils/anomaly-detector';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, AlertCircle } from 'lucide-react';

interface HistoricalChartProps {
  title: string;
  points: TimeSeriesPoint[];
  metricName: string;
  unit: string;
  color: string;
  showTrendLine?: boolean;
  showAnomalies?: boolean;
  showThresholdLines?: boolean;
  warningThreshold?: number;
  criticalThreshold?: number;
  anomalySensitivity?: number;
  height?: number;
  onSelectAnomaly?: (anomaly: AnomalyPoint) => void;
}

export const HistoricalChart: React.FC<HistoricalChartProps> = ({
  title,
  points,
  metricName,
  unit,
  color,
  showTrendLine = true,
  showAnomalies = true,
  showThresholdLines = true,
  warningThreshold,
  criticalThreshold,
  anomalySensitivity = 2.2,
  height = 200,
  onSelectAnomaly,
}) => {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!points || points.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center p-6 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl min-h-[180px]">
        <span className="text-xs text-neutral-400 font-mono">No historical points recorded for this range yet.</span>
      </div>
    );
  }

  // Trendline calculation
  const trendResult = calculateTrendLine(points);

  // Anomaly detection
  const detectedAnomalies = detectAnomalies(points, {
    thresholdSigma: anomalySensitivity,
    metricName,
    unit,
  });

  const width = 640;
  const paddingX = 36;
  const paddingY = 24;

  const rawValues = points.map((p) => p.value);
  const minVal = 0;

  // Include threshold values when scaling so threshold lines are visible
  const thresholdValues = [
    typeof warningThreshold === 'number' ? warningThreshold : 0,
    typeof criticalThreshold === 'number' ? criticalThreshold : 0,
  ];

  const maxVal = Math.max(
    10,
    Math.ceil(
      Math.max(
        ...rawValues,
        ...trendResult.points.map((t) => t.value),
        ...thresholdValues
      ) * (criticalThreshold ? 1.08 : 1.15)
    )
  );

  const getX = (idx: number) => paddingX + (idx / (points.length - 1)) * (width - paddingX * 2);
  const getY = (val: number) =>
    height - paddingY - ((val - minVal) / (maxVal - minVal || 1)) * (height - paddingY * 2);

  // SVG Line paths
  const metricPathD = points.reduce((acc, p, idx) => `${acc} ${idx === 0 ? 'M' : 'L'} ${getX(idx)} ${getY(p.value)}`, '');
  const areaD = `${metricPathD} L ${getX(points.length - 1)} ${height - paddingY} L ${getX(0)} ${height - paddingY} Z`;

  const trendPathD = trendResult.points.reduce(
    (acc, p, idx) => `${acc} ${idx === 0 ? 'M' : 'L'} ${getX(idx)} ${getY(p.value)}`,
    ''
  );

  // Map anomalies to points
  const anomalyTimestamps = new Set(detectedAnomalies.map((a) => a.timestamp));

  // Current hovered or latest point
  const activeIdx = hoverIndex !== null ? hoverIndex : points.length - 1;
  const activePoint = points[activeIdx];
  const activeTrendPoint = trendResult.points[activeIdx];
  const activeAnomaly = detectedAnomalies.find((a) => a.timestamp === activePoint?.timestamp);

  // Y-axis grid ticks
  const yTicks = [0, Math.round(maxVal * 0.33), Math.round(maxVal * 0.66), Math.round(maxVal)];

  // X-axis time labels
  const firstDate = new Date(points[0].timestamp);
  const lastDate = new Date(points[points.length - 1].timestamp);
  const isMultiDay = points[points.length - 1].timestamp - points[0].timestamp > 24 * 3600 * 1000;

  const formatTime = (d: Date) =>
    isMultiDay
      ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
      : `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;

  // Threshold line positions
  const hasWarn = showThresholdLines && typeof warningThreshold === 'number' && warningThreshold <= maxVal;
  const hasCrit = showThresholdLines && typeof criticalThreshold === 'number' && criticalThreshold <= maxVal;
  const warnY = hasWarn ? getY(warningThreshold!) : null;
  const critY = hasCrit ? getY(criticalThreshold!) : null;

  return (
    <div className="flex flex-col p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl shadow-xs hover:border-neutral-700 transition-all select-none">
      {/* Header with Title and Trend indicator */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-xs text-neutral-200">{title}</span>
          {detectedAnomalies.length > 0 && showAnomalies && (
            <span className="flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded bg-rose-950/80 border border-rose-800/60 text-rose-300">
              <AlertCircle className="w-3 h-3 text-rose-400" />
              <span>{detectedAnomalies.length} Anomaly{detectedAnomalies.length > 1 ? 'ies' : ''}</span>
            </span>
          )}
          {/* Threshold badges */}
          {hasWarn && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-800/60 text-amber-300">
              Warn: {warningThreshold}%
            </span>
          )}
          {hasCrit && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-800/60 text-rose-300">
              Crit: {criticalThreshold}%
            </span>
          )}
        </div>

        {/* Trend summary badge */}
        <div className="flex items-center gap-3 font-mono text-xs">
          {showTrendLine && (
            <div className="flex items-center gap-1">
              {trendResult.direction === 'rising' ? (
                <span className="text-amber-400 flex items-center gap-0.5 text-[11px]">
                  <TrendingUp className="w-3 h-3" />
                  <span>+{trendResult.percentChange}% Trend</span>
                </span>
              ) : trendResult.direction === 'falling' ? (
                <span className="text-emerald-400 flex items-center gap-0.5 text-[11px]">
                  <TrendingDown className="w-3 h-3" />
                  <span>{trendResult.percentChange}% Trend</span>
                </span>
              ) : (
                <span className="text-neutral-400 flex items-center gap-0.5 text-[11px]">
                  <Minus className="w-3 h-3" />
                  <span>Stable Trend</span>
                </span>
              )}
            </div>
          )}

          <div className="text-neutral-300 tabular-nums font-bold">
            {activePoint ? (Math.round(activePoint.value * 10) / 10).toFixed(1) : '0.0'}{' '}
            <span className="text-[10px] text-neutral-400 font-normal">{unit}</span>
          </div>
        </div>
      </div>

      {/* SVG Canvas */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full overflow-visible"
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id={`hist-grad-${metricName}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.25" />
              <stop offset="100%" stopColor={color} stopOpacity="0.0" />
            </linearGradient>
            <filter id="anomaly-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Shaded Threshold Alert Zones */}
          {hasCrit && critY !== null && (
            <rect
              x={paddingX}
              y={Math.max(paddingY, critY)}
              width={width - paddingX * 2}
              height={Math.max(0, (warnY ?? height - paddingY) - Math.max(paddingY, critY))}
              fill="#ef4444"
              fillOpacity="0.06"
            />
          )}
          {hasWarn && warnY !== null && (
            <rect
              x={paddingX}
              y={Math.max(paddingY, warnY)}
              width={width - paddingX * 2}
              height={Math.max(0, height - paddingY - Math.max(paddingY, warnY))}
              fill="#f59e0b"
              fillOpacity="0.03"
            />
          )}

          {/* Horizontal Grid lines and Y labels */}
          {yTicks.map((tickVal, i) => {
            const y = getY(tickVal);
            return (
              <g key={i}>
                <line
                  x1={paddingX}
                  y1={y}
                  x2={width - paddingX}
                  y2={y}
                  stroke="#262626"
                  strokeDasharray="2 3"
                  strokeWidth="1"
                />
                <text
                  x={paddingX - 6}
                  y={y + 3}
                  textAnchor="end"
                  fill="#737373"
                  fontSize="9"
                  fontFamily="monospace"
                >
                  {tickVal}
                </text>
              </g>
            );
          })}

          {/* Threshold Reference Lines and Labels */}
          {hasWarn && warnY !== null && (
            <g>
              <line
                x1={paddingX}
                y1={warnY}
                x2={width - paddingX}
                y2={warnY}
                stroke="#f59e0b"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                strokeOpacity="0.85"
              />
              <text
                x={width - paddingX - 4}
                y={warnY - 4}
                textAnchor="end"
                fill="#f59e0b"
                fontSize="9"
                fontFamily="monospace"
                fontWeight="600"
              >
                WARN {warningThreshold}%
              </text>
            </g>
          )}

          {hasCrit && critY !== null && (
            <g>
              <line
                x1={paddingX}
                y1={critY}
                x2={width - paddingX}
                y2={critY}
                stroke="#ef4444"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                strokeOpacity="0.85"
              />
              <text
                x={width - paddingX - 4}
                y={critY - 4}
                textAnchor="end"
                fill="#ef4444"
                fontSize="9"
                fontFamily="monospace"
                fontWeight="600"
              >
                CRIT {criticalThreshold}%
              </text>
            </g>
          )}

          {/* Area fill */}
          <path d={areaD} fill={`url(#hist-grad-${metricName})`} />

          {/* Trend line (Dashed) */}
          {showTrendLine && (
            <path
              d={trendPathD}
              fill="none"
              stroke="#fbbf24"
              strokeWidth="1.8"
              strokeDasharray="4 4"
              strokeOpacity="0.8"
            />
          )}

          {/* Primary Metric Line */}
          <path
            d={metricPathD}
            fill="none"
            stroke={color}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Anomaly markers */}
          {showAnomalies &&
            detectedAnomalies.map((a, i) => {
              const idx = points.findIndex((p) => p.timestamp === a.timestamp);
              if (idx < 0) return null;
              const ax = getX(idx);
              const ay = getY(a.value);
              const isHigh = a.severity === 'high';
              const markerColor = isHigh ? '#f43f5e' : '#f59e0b';

              return (
                <g
                  key={i}
                  className="cursor-pointer"
                  onClick={() => onSelectAnomaly && onSelectAnomaly(a)}
                >
                  {/* Outer pulse ring */}
                  <circle
                    cx={ax}
                    cy={ay}
                    r={isHigh ? 9 : 7}
                    fill={markerColor}
                    opacity="0.3"
                    className="animate-ping"
                  />
                  {/* Center marker */}
                  <circle
                    cx={ax}
                    cy={ay}
                    r={isHigh ? 5 : 4}
                    fill={markerColor}
                    stroke="#ffffff"
                    strokeWidth="1.5"
                    filter="url(#anomaly-glow)"
                  />
                </g>
              );
            })}

          {/* Interactive hover crosshair and points */}
          {points.map((p, idx) => {
            const px = getX(idx);
            const py = getY(p.value);
            const isHovered = hoverIndex === idx;

            return (
              <circle
                key={idx}
                cx={px}
                cy={py}
                r={isHovered ? 4.5 : 2}
                fill={isHovered ? '#ffffff' : color}
                stroke={color}
                strokeWidth="1.5"
                opacity={isHovered || anomalyTimestamps.has(p.timestamp) ? 1 : 0}
                className="cursor-pointer transition-all"
                onMouseEnter={() => setHoverIndex(idx)}
              />
            );
          })}

          {/* Active pointer guide */}
          {hoverIndex !== null && (
            <line
              x1={getX(hoverIndex)}
              y1={paddingY}
              x2={getX(hoverIndex)}
              y2={height - paddingY}
              stroke="#525252"
              strokeDasharray="2 2"
              strokeWidth="1.2"
            />
          )}
        </svg>

        {/* X-axis time endpoints */}
        <div className="flex justify-between items-center text-[10px] text-neutral-500 font-mono mt-1 px-1">
          <span>{formatTime(firstDate)}</span>
          <span className="text-neutral-400">
            {activePoint ? formatTime(new Date(activePoint.timestamp)) : ''}
          </span>
          <span>{formatTime(lastDate)}</span>
        </div>
      </div>

      {/* Scrubber Detail Tooltip Banner */}
      <div className="mt-2.5 pt-2 border-t border-neutral-800/80 flex flex-wrap items-center justify-between text-xs font-mono">
        <div className="text-neutral-400 flex items-center gap-2">
          <span>{new Date(activePoint.timestamp).toLocaleString()}</span>
          {showTrendLine && activeTrendPoint && (
            <span className="text-amber-400 text-[11px]">
              Trend: {activeTrendPoint.value}{unit}
            </span>
          )}
        </div>

        {activeAnomaly ? (
          <div className="flex items-center gap-1.5 text-rose-400 text-[11px] font-semibold bg-rose-950/40 px-2 py-0.5 rounded border border-rose-900/60">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{activeAnomaly.description}</span>
          </div>
        ) : (
          <div className="text-neutral-500 text-[11px]">
            Baseline: Nominal (no anomaly)
          </div>
        )}
      </div>
    </div>
  );
};
