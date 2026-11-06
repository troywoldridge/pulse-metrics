/**
 * Statistical calculations for trend line regression and anomaly detection.
 */

export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

export interface AnomalyPoint {
  timestamp: number;
  value: number;
  expectedValue: number;
  deviationSigma: number;
  severity: 'low' | 'medium' | 'high';
  type: 'spike' | 'drop' | 'unusual_trend';
  description: string;
}

export interface TrendLineResult {
  points: TimeSeriesPoint[];
  slope: number;
  direction: 'rising' | 'falling' | 'stable';
  percentChange: number;
}

/**
 * Calculates a Linear Regression Trend Line over a series of points.
 * y = mx + b
 */
export function calculateTrendLine(points: TimeSeriesPoint[]): TrendLineResult {
  if (points.length < 2) {
    return {
      points: [...points],
      slope: 0,
      direction: 'stable',
      percentChange: 0,
    };
  }

  const n = points.length;
  const firstTime = points[0].timestamp;
  const timeScale = (points[points.length - 1].timestamp - firstTime) || 1;

  // Normalized x between 0 and 1 to prevent numerical precision issues
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = (points[i].timestamp - firstTime) / timeScale;
    const y = points[i].value;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  const slope = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;
  const intercept = (sumY - slope * sumX) / n;

  const trendPoints: TimeSeriesPoint[] = points.map((p) => {
    const x = (p.timestamp - firstTime) / timeScale;
    const y = slope * x + intercept;
    return {
      timestamp: p.timestamp,
      value: Math.max(0, Math.round(y * 10) / 10),
    };
  });

  const startVal = trendPoints[0].value;
  const endVal = trendPoints[trendPoints.length - 1].value;
  const percentChange = startVal !== 0 ? Math.round(((endVal - startVal) / startVal) * 100) : 0;

  const direction: 'rising' | 'falling' | 'stable' =
    Math.abs(percentChange) < 3 ? 'stable' : percentChange > 0 ? 'rising' : 'falling';

  return {
    points: trendPoints,
    slope,
    direction,
    percentChange,
  };
}

/**
 * Calculates Simple Moving Average (SMA)
 */
export function calculateMovingAverage(points: TimeSeriesPoint[], windowSize: number = 5): TimeSeriesPoint[] {
  if (points.length === 0) return [];
  const result: TimeSeriesPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const windowSlice = points.slice(start, i + 1);
    const avg = windowSlice.reduce((sum, p) => sum + p.value, 0) / windowSlice.length;
    result.push({
      timestamp: points[i].timestamp,
      value: Math.round(avg * 10) / 10,
    });
  }

  return result;
}

/**
 * Automated Statistical Anomaly Detection using rolling Z-Score and Interquartile Variance
 */
export function detectAnomalies(
  points: TimeSeriesPoint[],
  options?: {
    thresholdSigma?: number;
    windowSize?: number;
    metricName?: string;
    unit?: string;
  }
): AnomalyPoint[] {
  if (points.length < 6) return [];

  const thresholdSigma = options?.thresholdSigma ?? 2.2;
  const windowSize = Math.max(4, options?.windowSize ?? Math.min(15, Math.floor(points.length / 4)));
  const metricName = options?.metricName ?? 'Metric';
  const unit = options?.unit ?? '%';

  const anomalies: AnomalyPoint[] = [];

  for (let i = windowSize; i < points.length; i++) {
    const windowSlice = points.slice(i - windowSize, i);
    const mean = windowSlice.reduce((acc, p) => acc + p.value, 0) / windowSlice.length;

    const variance =
      windowSlice.reduce((acc, p) => acc + Math.pow(p.value - mean, 2), 0) / windowSlice.length;
    const stdDev = Math.sqrt(variance);

    // Minimum baseline variance to avoid zero division on flat lines
    const effectiveStdDev = Math.max(stdDev, 1.5);
    const current = points[i];
    const diff = current.value - mean;
    const zScore = Math.abs(diff) / effectiveStdDev;

    if (zScore >= thresholdSigma) {
      const isSpike = diff > 0;
      const severity: 'low' | 'medium' | 'high' =
        zScore >= 3.5 ? 'high' : zScore >= 2.8 ? 'medium' : 'low';

      anomalies.push({
        timestamp: current.timestamp,
        value: current.value,
        expectedValue: Math.round(mean * 10) / 10,
        deviationSigma: Math.round(zScore * 10) / 10,
        severity,
        type: isSpike ? 'spike' : 'drop',
        description: `${metricName} ${isSpike ? 'surge' : 'plunge'} to ${current.value}${unit} (${Math.round(zScore * 10) / 10}σ from baseline ${Math.round(mean * 10) / 10}${unit})`,
      });
    }
  }

  return anomalies;
}
