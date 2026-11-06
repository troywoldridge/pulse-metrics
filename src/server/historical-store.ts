import { HistoricalDataPoint, TimeRangeOption } from '../types/metrics';

const historicalDataStore: Record<string, HistoricalDataPoint[]> = {
  'linux-pc': [],
  'work-server': [],
};

/**
 * Generate 7 days of realistic historical telemetry with distinct diurnal cycles and anomalies
 */
export function seedHistoricalData() {
  const now = Date.now();
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  for (const hostId of ['linux-pc', 'work-server']) {
    const isWorkServer = hostId === 'work-server';
    const series: HistoricalDataPoint[] = [];

    // Phase 1: 7 days ago up to 2 hours ago (15-min intervals)
    const longTermPoints = Math.floor((sevenDaysMs - twoHoursMs) / (15 * 60 * 1000));
    for (let i = longTermPoints; i > 0; i--) {
      const ts = now - twoHoursMs - i * 15 * 60 * 1000;
      generateHistoricalPoint(ts, isWorkServer, series);
    }

    // Phase 2: Recent 2 hours up to now (1-minute intervals)
    const shortTermPoints = 120;
    for (let i = shortTermPoints; i >= 0; i--) {
      const ts = now - i * 60 * 1000;
      generateHistoricalPoint(ts, isWorkServer, series);
    }

    historicalDataStore[hostId] = series;
  }
}

function generateHistoricalPoint(ts: number, isWorkServer: boolean, series: HistoricalDataPoint[]) {
  const now = Date.now();
  const date = new Date(ts);
  const hour = date.getHours() + date.getMinutes() / 60;
  const isWorkHours = hour >= 8.5 && hour <= 18.5;
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;

  // Base loads
  const activityFactor = isWeekend ? 0.35 : isWorkHours ? 1.0 : 0.25;

  // Natural diurnal CPU
  let cpuBase = isWorkServer
    ? 24 + activityFactor * 26 + Math.sin(hour / 3) * 6
    : 16 + activityFactor * 16 + Math.sin(hour / 4) * 4;
  let cpu = Math.max(4, Math.min(100, Math.round((cpuBase + (Math.random() - 0.5) * 8) * 10) / 10));

  // Memory baseline
  let memBase = isWorkServer
    ? 36 + activityFactor * 10 + (hour / 24) * 4
    : 24 + activityFactor * 6;
  let memory = Math.max(10, Math.min(95, Math.round((memBase + (Math.random() - 0.5) * 3) * 10) / 10));

  // Network bandwidth in Mbps
  let dlBase = isWorkServer ? 50 + activityFactor * 120 : 25 + activityFactor * 60;
  let ulBase = isWorkServer ? 22 + activityFactor * 60 : 10 + activityFactor * 20;
  let downloadMbps = Math.max(1, Math.round((dlBase + (Math.random() - 0.5) * 20) * 10) / 10);
  let uploadMbps = Math.max(0.5, Math.round((ulBase + (Math.random() - 0.5) * 10) * 10) / 10);

  // Disk usage and I/O
  let diskUsage = isWorkServer ? 41.5 : 39.0;
  let diskIo = Math.max(0.5, Math.round((2.5 + activityFactor * 14 + Math.random() * 5) * 10) / 10);

  // Anomaly 1: Heavy batch compilation (2 days ago at ~14:30)
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000 + 14.5 * 3600 * 1000;
  if (Math.abs(ts - twoDaysAgo) < 45 * 60 * 1000) {
    cpu = Math.min(98.5, cpu + 54);
    diskIo = Math.min(380, diskIo + 260);
  }

  // Anomaly 2: Automated cluster backup spike (3 days ago at 03:15 AM)
  const threeDaysAgoNight = now - 3 * 24 * 60 * 60 * 1000 + 3.25 * 3600 * 1000;
  if (Math.abs(ts - threeDaysAgoNight) < 30 * 60 * 1000) {
    diskIo = Math.min(450, diskIo + 340);
    downloadMbps = Math.min(820, downloadMbps + 480);
  }

  // Anomaly 3: Memory leak / contention (yesterday afternoon ~16:00)
  const yesterdayAfternoon = now - 1 * 24 * 60 * 60 * 1000 + 16 * 3600 * 1000;
  if (Math.abs(ts - yesterdayAfternoon) < 60 * 60 * 1000) {
    memory = Math.min(94.2, memory + 42);
    cpu = Math.min(92, cpu + 35);
  }

  // Anomaly 4: Network Egress Outlier (4 hours ago)
  const fourHoursAgo = now - 4 * 3600 * 1000;
  if (Math.abs(ts - fourHoursAgo) < 25 * 60 * 1000) {
    downloadMbps = Math.min(890, downloadMbps + 640);
    uploadMbps = Math.min(680, uploadMbps + 510);
  }

  // Anomaly 5: Recent CPU & Network burst (35 minutes ago, visible in 1h and 15m views)
  const thirtyFiveMinsAgo = now - 35 * 60 * 1000;
  if (Math.abs(ts - thirtyFiveMinsAgo) < 6 * 60 * 1000) {
    cpu = Math.min(95.4, cpu + 52);
    downloadMbps = Math.min(740, downloadMbps + 520);
  }

  series.push({
    timestamp: ts,
    cpu,
    memory,
    downloadMbps,
    uploadMbps,
    diskUsage: Math.round(diskUsage * 10) / 10,
    diskIoMbps: Math.round(diskIo * 10) / 10,
  });
}

// Seed upon module load
seedHistoricalData();

/**
 * Append live real-time point
 */
export function appendLivePoint(hostId: string, point: HistoricalDataPoint) {
  if (!historicalDataStore[hostId]) {
    historicalDataStore[hostId] = [];
  }
  const store = historicalDataStore[hostId];
  store.push(point);

  // Keep up to 2000 points per host (~3 weeks at 15m intervals or high frequency)
  if (store.length > 2500) {
    store.shift();
  }
}

/**
 * Query historical data for a specific host and time range
 */
export function queryHistoricalData(
  hostId: string,
  range: TimeRangeOption = '1h'
): HistoricalDataPoint[] {
  const store = historicalDataStore[hostId] || historicalDataStore['linux-pc'] || [];
  const now = Date.now();

  let durationMs: number;
  let targetSampleCount: number;

  switch (range) {
    case '15m':
      durationMs = 15 * 60 * 1000;
      targetSampleCount = 60;
      break;
    case '1h':
      durationMs = 60 * 60 * 1000;
      targetSampleCount = 60;
      break;
    case '24h':
      durationMs = 24 * 60 * 60 * 1000;
      targetSampleCount = 96;
      break;
    case '7d':
    default:
      durationMs = 7 * 24 * 60 * 60 * 1000;
      targetSampleCount = 112;
      break;
  }

  const cutoff = now - durationMs;
  const inRange = store.filter((p) => p.timestamp >= cutoff);

  // If inRange has more points than targetSampleCount, downsample evenly
  if (inRange.length <= targetSampleCount) {
    return inRange;
  }

  const step = inRange.length / targetSampleCount;
  const downsampled: HistoricalDataPoint[] = [];

  for (let i = 0; i < targetSampleCount; i++) {
    const idx = Math.min(Math.floor(i * step), inRange.length - 1);
    downsampled.push(inRange[idx]);
  }

  // Always include the latest point
  if (downsampled[downsampled.length - 1] !== inRange[inRange.length - 1]) {
    downsampled[downsampled.length - 1] = inRange[inRange.length - 1];
  }

  return downsampled;
}
