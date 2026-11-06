import React from 'react';
import { formatBitsPerSec, formatBytes, clamp } from '../utils/metrics-calculator';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';

interface DualBandwidthDialProps {
  downloadBps: number;
  uploadBps: number;
  totalReceivedBytes: number;
  totalSentBytes: number;
  interfaceName: string;
}

export const DualBandwidthDial: React.FC<DualBandwidthDialProps> = ({
  downloadBps,
  uploadBps,
  totalReceivedBytes,
  totalSentBytes,
  interfaceName,
}) => {
  // Convert bps to Mbps (bits per sec = downloadBps * 8)
  const dlMbps = (downloadBps * 8) / 1000000;
  const ulMbps = (uploadBps * 8) / 1000000;

  // Dynamic scale ceiling (e.g. 50, 100, 500, 1000 Mbps)
  const maxScale = Math.max(50, Math.ceil(Math.max(dlMbps, ulMbps) / 50) * 50);

  const dlRatio = clamp(dlMbps / maxScale, 0, 1);
  const ulRatio = clamp(ulMbps / maxScale, 0, 1);

  // SVG dimensions
  const width = 280;
  const height = 165;
  const cx = width / 2;
  const cy = 135;
  const r = 100;

  // Semicircular angle: -180 to 0 degrees
  const angleToCoord = (degrees: number, radius: number) => {
    const rad = (degrees * Math.PI) / 180;
    return {
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad),
    };
  };

  // Download needle angle (-180 to -90 for left half or across full -180 to 0)
  // Let's use two distinct concentric arcs: Outer is Download (cyan), Inner is Upload (violet)
  const dlAngle = -180 + dlRatio * 180;
  const ulAngle = -180 + ulRatio * 180;

  const dlNeedle = angleToCoord(dlAngle, r - 5);
  const ulNeedle = angleToCoord(ulAngle, r - 25);

  return (
    <div className="flex flex-col p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl relative shadow-sm hover:border-neutral-700 transition-all">
      <div className="flex items-center justify-between text-xs text-neutral-400 font-medium mb-1">
        <div className="flex items-center gap-1.5 text-neutral-200">
          <span>Network Throughput</span>
        </div>
        <span className="font-mono text-[11px] text-neutral-500">{interfaceName}</span>
      </div>

      <div className="relative flex justify-center items-center my-1">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <filter id="dl-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            <filter id="ul-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Semicircle outer base track (Download) */}
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none"
            stroke="#1e293b"
            strokeWidth="8"
            strokeLinecap="round"
          />

          {/* Download active arc (Cyan) */}
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 ${dlRatio > 0.5 ? 1 : 0} 1 ${angleToCoord(dlAngle, r).x} ${angleToCoord(dlAngle, r).y}`}
            fill="none"
            stroke="#06b6d4"
            strokeWidth="8"
            strokeLinecap="round"
            filter="url(#dl-glow)"
            className="transition-all duration-300 ease-out"
          />

          {/* Semicircle inner base track (Upload) */}
          <path
            d={`M ${cx - (r - 18)} ${cy} A ${r - 18} ${r - 18} 0 0 1 ${cx + (r - 18)} ${cy}`}
            fill="none"
            stroke="#1e293b"
            strokeWidth="6"
            strokeLinecap="round"
          />

          {/* Upload active arc (Violet) */}
          <path
            d={`M ${cx - (r - 18)} ${cy} A ${r - 18} ${r - 18} 0 ${ulRatio > 0.5 ? 1 : 0} 1 ${angleToCoord(ulAngle, r - 18).x} ${angleToCoord(ulAngle, r - 18).y}`}
            fill="none"
            stroke="#a855f7"
            strokeWidth="6"
            strokeLinecap="round"
            filter="url(#ul-glow)"
            className="transition-all duration-300 ease-out"
          />

          {/* Scale labels */}
          <text x={cx - r + 8} y={cy + 16} fill="#64748b" fontSize="10" fontFamily="monospace">0</text>
          <text x={cx} y={cy - r + 14} textAnchor="middle" fill="#64748b" fontSize="10" fontFamily="monospace">
            {maxScale / 2}M
          </text>
          <text x={cx + r - 8} y={cy + 16} textAnchor="end" fill="#64748b" fontSize="10" fontFamily="monospace">
            {maxScale}M
          </text>

          {/* Needles */}
          {/* Download Needle (Cyan) */}
          <line
            x1={cx}
            y1={cy}
            x2={dlNeedle.x}
            y2={dlNeedle.y}
            stroke="#06b6d4"
            strokeWidth="2"
            strokeLinecap="round"
            className="transition-all duration-200 ease-out"
          />

          {/* Upload Needle (Violet) */}
          <line
            x1={cx}
            y1={cy}
            x2={ulNeedle.x}
            y2={ulNeedle.y}
            stroke="#a855f7"
            strokeWidth="1.8"
            strokeLinecap="round"
            className="transition-all duration-200 ease-out"
          />

          {/* Center Hub */}
          <circle cx={cx} cy={cy} r="6" fill="#0f172a" stroke="#475569" strokeWidth="1.5" />
          <circle cx={cx} cy={cy} r="2.5" fill="#e2e8f0" />
        </svg>
      </div>

      {/* Metrics Readout */}
      <div className="grid grid-cols-2 gap-2 mt-1 pt-2 border-t border-neutral-800">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-950/60 text-cyan-400 border border-cyan-800/40">
            <ArrowDownLeft className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="text-[10px] uppercase font-mono tracking-wider text-neutral-400">Download</div>
            <div className="text-sm font-bold font-mono tabular-nums text-cyan-400">
              {formatBitsPerSec(downloadBps * 8)}
            </div>
            <div className="text-[10px] text-neutral-500 font-mono">
              Tot: {formatBytes(totalReceivedBytes)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-purple-950/60 text-purple-400 border border-purple-800/40">
            <ArrowUpRight className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="text-[10px] uppercase font-mono tracking-wider text-neutral-400">Upload</div>
            <div className="text-sm font-bold font-mono tabular-nums text-purple-400">
              {formatBitsPerSec(uploadBps * 8)}
            </div>
            <div className="text-[10px] text-neutral-500 font-mono">
              Tot: {formatBytes(totalSentBytes)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
