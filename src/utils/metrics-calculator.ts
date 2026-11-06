import { ConnectionState, HealthRating } from '../types/metrics';

/**
 * Format raw bytes into human readable format (KB, MB, GB, TB)
 */
export function formatBytes(bytes: number, decimals: number = 1): string {
  if (bytes === 0) return '0 B';
  if (isNaN(bytes) || !isFinite(bytes)) return '0 B';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const safeI = Math.min(i, sizes.length - 1);
  const value = bytes / Math.pow(k, safeI);

  return `${parseFloat(value.toFixed(dm))} ${sizes[safeI]}`;
}

/**
 * Format network speed in bits per second (Kbps, Mbps, Gbps)
 */
export function formatBitsPerSec(bps: number, decimals: number = 1): string {
  if (bps === 0 || isNaN(bps) || !isFinite(bps)) return '0 bps';

  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps'];

  const i = Math.floor(Math.log(Math.abs(bps)) / Math.log(k));
  const safeI = Math.min(Math.max(i, 0), sizes.length - 1);
  const value = bps / Math.pow(k, safeI);

  return `${parseFloat(value.toFixed(dm))} ${sizes[safeI]}`;
}

/**
 * Format uptime in seconds to formatted string (e.g., "14d 6h 32m" or "4h 12m 30s")
 */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0 || isNaN(seconds)) return '0s';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Clamp a number between min and max
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

/**
 * Convert value into dial angle in degrees.
 * Typically startAngle = -135 (bottom left), sweepAngle = 270 (ending at bottom right)
 */
export function valueToDialAngle(
  val: number,
  min: number,
  max: number,
  startAngle: number = -135,
  sweepAngle: number = 270
): number {
  if (max <= min) return startAngle;
  const ratio = clamp((val - min) / (max - min), 0, 1);
  return startAngle + ratio * sweepAngle;
}

/**
 * Convert polar coordinates to Cartesian (SVG space)
 */
export function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

/**
 * Generate SVG Path string for circular gauge arc
 */
export function describeArc(
  x: number,
  y: number,
  radius: number,
  startAngle: number,
  endAngle: number
): string {
  // If arc is full circle or almost full, clip slightly to avoid SVG degenerate arc
  if (Math.abs(endAngle - startAngle) >= 359.99) {
    endAngle = startAngle + 359.99;
  }

  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return ['M', start.x, start.y, 'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y].join(' ');
}

/**
 * Assess connection health rating based on latency, packet loss, and reconnect state
 */
export function computeConnectionHealth(
  rttMs: number,
  packetLossPercent: number,
  reconnectAttempts: number,
  status: ConnectionState
): HealthRating {
  if (status === 'disconnected' || status === 'error') {
    return 'offline';
  }
  if (status === 'authenticating' || status === 'reconnecting') {
    return 'degraded';
  }

  if (packetLossPercent > 10 || rttMs > 250 || reconnectAttempts > 3) {
    return 'poor';
  }
  if (packetLossPercent > 2 || rttMs > 120 || reconnectAttempts > 0) {
    return 'degraded';
  }
  if (rttMs > 60) {
    return 'good';
  }
  return 'excellent';
}

/**
 * Determine severity color category based on thresholds
 */
export function getSeverity(
  val: number,
  warn: number = 75,
  critical: number = 90
): 'normal' | 'warning' | 'critical' {
  if (val >= critical) return 'critical';
  if (val >= warn) return 'warning';
  return 'normal';
}

export interface ThresholdBand {
  zone: 'normal' | 'warning' | 'critical';
  startAngle: number;
  endAngle: number;
  color: string;
  arcPath: string;
}

/**
 * Calculate colored SVG arc bands for normal, warning, and critical zones
 */
export function calculateThresholdBands(
  center: number,
  radius: number,
  min: number,
  max: number,
  warning: number,
  critical: number,
  startAngle: number = -135,
  sweepAngle: number = 270
): ThresholdBand[] {
  const safeWarn = clamp(warning, min, max);
  const safeCrit = clamp(critical, safeWarn, max);

  const warnAngle = valueToDialAngle(safeWarn, min, max, startAngle, sweepAngle);
  const critAngle = valueToDialAngle(safeCrit, min, max, startAngle, sweepAngle);
  const endAngle = startAngle + sweepAngle;

  return [
    {
      zone: 'normal',
      startAngle,
      endAngle: warnAngle,
      color: '#10b981',
      arcPath: describeArc(center, center, radius, startAngle, warnAngle > startAngle ? warnAngle : startAngle + 0.1),
    },
    {
      zone: 'warning',
      startAngle: warnAngle,
      endAngle: critAngle,
      color: '#f59e0b',
      arcPath: describeArc(center, center, radius, warnAngle, critAngle > warnAngle ? critAngle : warnAngle + 0.1),
    },
    {
      zone: 'critical',
      startAngle: critAngle,
      endAngle,
      color: '#ef4444',
      arcPath: describeArc(center, center, radius, critAngle, endAngle > critAngle ? endAngle : critAngle + 0.1),
    },
  ];
}

