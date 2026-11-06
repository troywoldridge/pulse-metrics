export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected' | 'error' | 'authenticating';

export type HealthRating = 'excellent' | 'good' | 'degraded' | 'poor' | 'offline';

export interface HostCpuMetrics {
  usagePercent: number; // 0 - 100
  cores: number;
  perCoreUsage: number[];
  loadAverage: [number, number, number]; // 1, 5, 15 min
  temperatureC: number;
  freqMhz?: number;
}

export interface HostMemoryMetrics {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  cachedBytes: number;
  usagePercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapPercent: number;
}

export interface HostDiskMetrics {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
  readSpeedBps: number;
  writeSpeedBps: number;
  mountPoint: string;
}

export interface HostNetworkMetrics {
  downloadBps: number;
  uploadBps: number;
  totalReceivedBytes: number;
  totalSentBytes: number;
  interfaceName: string;
}

export interface InternetSpeedMetrics {
  downloadSpeedMbps: number;
  uploadSpeedMbps: number;
  pingMs: number;
  jitterMs: number;
  packetLossPercent: number;
  lastTested?: number;
  status: 'idle' | 'testing' | 'completed' | 'failed';
}

export interface HostLatencyMetrics {
  currentMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  packetLossPercent: number;
  jitterMs: number;
  history: number[];
}

export interface ConnectionHealth {
  state: HealthRating;
  sshUptimeSec: number;
  sshBufferHealth: number; // 0 - 100%
  reconnectAttempts: number;
  rttMs: number;
  lastHeartbeat: number;
  diagnosticsMessage: string;
}

export interface ProcessItem {
  pid: number;
  name: string;
  user: string;
  cpuPercent: number;
  memPercent: number;
  memBytes: number;
  status: string;
}

export interface HistoricalSeries {
  timestamps: number[];
  cpu: number[];
  memory: number[];
  downloadBps: number[];
  uploadBps: number[];
  latencyMs: number[];
}

export interface ServerLogItem {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'ssh';
  message: string;
}

export interface HostMetrics {
  hostId: string;
  name: string;
  hostname: string;
  connectionType: 'ssh' | 'local' | 'agent';
  sshCommand: string;
  status: ConnectionState;
  lastUpdated: number;
  uptimeSeconds: number;
  os: {
    name: string;
    kernel: string;
    arch: string;
  };
  cpu: HostCpuMetrics;
  memory: HostMemoryMetrics;
  disk: HostDiskMetrics;
  network: HostNetworkMetrics;
  networkSpeed: InternetSpeedMetrics;
  latency: HostLatencyMetrics;
  connectionHealth: ConnectionHealth;
  topProcesses: ProcessItem[];
  history: HistoricalSeries;
  logs: ServerLogItem[];
}

export interface WidgetLayoutConfig {
  id: string;
  name: string;
  visible: boolean;
  order: number;
  width: 'full' | 'half' | 'third';
}

export interface HistoricalDataPoint {
  timestamp: number;
  cpu: number;
  memory: number;
  downloadMbps: number;
  uploadMbps: number;
  diskUsage: number;
  diskIoMbps: number;
}

export type TimeRangeOption = '15m' | '1h' | '24h' | '7d';

export type HistoricalMetricKey = 'cpu' | 'memory' | 'downloadMbps' | 'uploadMbps' | 'diskUsage' | 'diskIoMbps';

export interface MetricThresholds {
  warning: number;
  critical: number;
}

export interface HostThresholdConfig {
  cpu: MetricThresholds;
  memory: MetricThresholds;
  disk: MetricThresholds;
}

export type HostThresholdMap = Record<string, HostThresholdConfig>;

export const DEFAULT_THRESHOLDS: HostThresholdConfig = {
  cpu: { warning: 75, critical: 90 },
  memory: { warning: 80, critical: 92 },
  disk: { warning: 85, critical: 95 },
};

export interface DashboardSettings {
  pollingIntervalMs: number;
  theme: 'dark' | 'light';
  viewMode: 'grid' | 'compact' | 'focus';
  selectedHostId: string; // 'all' or specific hostId
  widgets: WidgetLayoutConfig[];
  thresholds: HostThresholdMap;
}

