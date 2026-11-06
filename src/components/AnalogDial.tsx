import React from 'react';
import {
  valueToDialAngle,
  polarToCartesian,
  describeArc,
  clamp,
  getSeverity,
  calculateThresholdBands,
} from '../utils/metrics-calculator';

interface AnalogDialProps {
  title: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
  subtitle?: string;
  warningThreshold?: number;
  criticalThreshold?: number;
  showThresholdBands?: boolean;
  size?: number;
  accentColor?: string;
  showTicks?: boolean;
  valueFormatter?: (val: number) => string;
}

export const AnalogDial: React.FC<AnalogDialProps> = ({
  title,
  value,
  min = 0,
  max = 100,
  unit = '%',
  subtitle,
  warningThreshold = 75,
  criticalThreshold = 90,
  showThresholdBands = true,
  size = 200,
  accentColor,
  showTicks = true,
  valueFormatter,
}) => {
  const clampedValue = clamp(value, min, max);
  const startAngle = -135;
  const sweepAngle = 270;
  const endAngle = 135;

  const currentAngle = valueToDialAngle(clampedValue, min, max, startAngle, sweepAngle);
  const severity = getSeverity(clampedValue, warningThreshold, criticalThreshold);

  // Dynamic colors
  const activeColor =
    accentColor ||
    (severity === 'critical' ? '#ef4444' : severity === 'warning' ? '#f59e0b' : '#10b981');

  const radius = size * 0.38;
  const center = size / 2;

  // Threshold bands along the arc track
  const thresholdBands = calculateThresholdBands(
    center,
    radius + 6,
    min,
    max,
    warningThreshold,
    criticalThreshold,
    startAngle,
    sweepAngle
  );

  // Warning & Critical marker coordinates
  const warnAngle = valueToDialAngle(clamp(warningThreshold, min, max), min, max, startAngle, sweepAngle);
  const critAngle = valueToDialAngle(clamp(criticalThreshold, min, max), min, max, startAngle, sweepAngle);
  const warnMarkerOuter = polarToCartesian(center, center, radius + 11, warnAngle);
  const warnMarkerInner = polarToCartesian(center, center, radius + 1, warnAngle);
  const critMarkerOuter = polarToCartesian(center, center, radius + 11, critAngle);
  const critMarkerInner = polarToCartesian(center, center, radius + 1, critAngle);

  // Track arc
  const trackArc = describeArc(center, center, radius, startAngle, endAngle);

  // Value arc
  const valueArc = describeArc(
    center,
    center,
    radius,
    startAngle,
    currentAngle > startAngle ? currentAngle : startAngle + 0.1
  );

  // Generate tick marks
  const ticks = [];
  const tickCount = 10;
  for (let i = 0; i <= tickCount; i++) {
    const tickVal = min + (i / tickCount) * (max - min);
    const tickAngle = startAngle + (i / tickCount) * sweepAngle;
    const isMajor = i % 2 === 0;
    const outerR = radius - 8;
    const innerR = outerR - (isMajor ? 8 : 4);

    const pOuter = polarToCartesian(center, center, outerR, tickAngle);
    const pInner = polarToCartesian(center, center, innerR, tickAngle);

    // Text label for major ticks
    const pText = polarToCartesian(center, center, innerR - 10, tickAngle);

    ticks.push({
      key: i,
      x1: pInner.x,
      y1: pInner.y,
      x2: pOuter.x,
      y2: pOuter.y,
      isMajor,
      label: isMajor ? Math.round(tickVal) : null,
      tx: pText.x,
      ty: pText.y,
    });
  }

  // Needle tip and base
  const needleLength = radius - 4;
  const needleTip = polarToCartesian(center, center, needleLength, currentAngle);
  const needleLeft = polarToCartesian(center, center, 6, currentAngle - 90);
  const needleRight = polarToCartesian(center, center, 6, currentAngle + 90);
  const needleBase = polarToCartesian(center, center, -12, currentAngle);

  const needlePath = `M ${needleLeft.x} ${needleLeft.y} L ${needleTip.x} ${needleTip.y} L ${needleRight.x} ${needleRight.y} L ${needleBase.x} ${needleBase.y} Z`;

  const displayVal = valueFormatter ? valueFormatter(value) : (Math.round(value * 10) / 10).toString();

  return (
    <div className="flex flex-col items-center justify-between p-3.5 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl relative shadow-sm hover:border-neutral-700 transition-all select-none">
      <div className="w-full flex items-center justify-between gap-2 text-xs font-medium px-1 mb-1">
        <span className="font-semibold text-neutral-200 truncate">{title}</span>
        {subtitle && (
          <span className="text-neutral-400 font-mono text-[11px] truncate shrink-0 max-w-[130px]">
            {subtitle}
          </span>
        )}
      </div>

      <div className="relative my-1 flex items-center justify-center">
        <svg width={size} height={size * 0.9} viewBox={`0 0 ${size} ${size}`}>
          <defs>
            {/* Outer bezel gradient */}
            <radialGradient id={`bezel-${title}`} cx="50%" cy="50%" r="50%">
              <stop offset="85%" stopColor="#1e293b" stopOpacity="0.8" />
              <stop offset="98%" stopColor="#0f172a" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#334155" stopOpacity="0.4" />
            </radialGradient>
            {/* Center cap gradient */}
            <radialGradient id={`cap-${title}`} cx="40%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#94a3b8" />
              <stop offset="60%" stopColor="#334155" />
              <stop offset="100%" stopColor="#0f172a" />
            </radialGradient>
            {/* Active glow */}
            <filter id={`glow-${title}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Bezel ring */}
          <circle
            cx={center}
            cy={center}
            r={radius + 14}
            fill={`url(#bezel-${title})`}
            stroke="#1e293b"
            strokeWidth="1.5"
          />

          {/* Colored Threshold Bands (Normal, Warning, Critical) */}
          {showThresholdBands &&
            thresholdBands.map((band, idx) => (
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

          {/* Background Track Arc */}
          <path
            d={trackArc}
            fill="none"
            stroke="#1e293b"
            strokeWidth="7"
            strokeLinecap="round"
          />

          {/* Active Value Arc */}
          <path
            d={valueArc}
            fill="none"
            stroke={activeColor}
            strokeWidth="7"
            strokeLinecap="round"
            filter={`url(#glow-${title})`}
            className="transition-all duration-300 ease-out"
          />

          {/* Threshold alert notch markers */}
          {showThresholdBands && (
            <g>
              {/* Warning boundary marker */}
              <line
                x1={warnMarkerInner.x}
                y1={warnMarkerInner.y}
                x2={warnMarkerOuter.x}
                y2={warnMarkerOuter.y}
                stroke="#f59e0b"
                strokeWidth="2.5"
              />
              {/* Critical boundary marker */}
              <line
                x1={critMarkerInner.x}
                y1={critMarkerInner.y}
                x2={critMarkerOuter.x}
                y2={critMarkerOuter.y}
                stroke="#ef4444"
                strokeWidth="2.5"
              />
            </g>
          )}

          {/* Ticks & Labels */}
          {showTicks &&
            ticks.map((t) => (
              <g key={t.key}>
                <line
                  x1={t.x1}
                  y1={t.y1}
                  x2={t.x2}
                  y2={t.y2}
                  stroke={t.isMajor ? '#64748b' : '#334155'}
                  strokeWidth={t.isMajor ? 1.5 : 1}
                />
                {t.label !== null && (
                  <text
                    x={t.tx}
                    y={t.ty + 3}
                    textAnchor="middle"
                    fill="#64748b"
                    fontSize="9"
                    fontFamily="monospace"
                    className="select-none"
                  >
                    {t.label}
                  </text>
                )}
              </g>
            ))}

          {/* Analog Needle with shadow */}
          <path
            d={needlePath}
            fill="rgba(0, 0, 0, 0.4)"
            transform="translate(1, 2)"
            className="transition-all duration-200 ease-out"
          />
          <path
            d={needlePath}
            fill={activeColor}
            className="transition-all duration-200 ease-out"
          />

          {/* Center Pivot Hub */}
          <circle
            cx={center}
            cy={center}
            r="9"
            fill={`url(#cap-${title})`}
            stroke="#475569"
            strokeWidth="1.5"
            className="drop-shadow"
          />
          <circle
            cx={center}
            cy={center}
            r="3"
            fill={activeColor}
          />
        </svg>

        {/* Digital Readout Inset */}
        <div className="absolute bottom-1.5 text-center pointer-events-none flex flex-col items-center">
          <div className="flex items-baseline justify-center gap-1 font-mono tabular-nums">
            <span
              className="text-xl font-bold tracking-tight drop-shadow transition-colors"
              style={{ color: activeColor }}
            >
              {displayVal}
            </span>
            <span className="text-xs font-semibold text-neutral-400">{unit}</span>
          </div>
          {/* Threshold alert tags */}
          {showThresholdBands && (
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-neutral-400 mt-0.5">
              <span className="text-amber-400/90 font-medium">W:{warningThreshold}%</span>
              <span>·</span>
              <span className="text-rose-400/90 font-medium">C:{criticalThreshold}%</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
