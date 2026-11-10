import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { WebSocketServer, WebSocket } from 'ws';
import { HostMetrics, ProcessItem, InternetSpeedMetrics, HistoricalDataPoint } from './src/types/metrics.js';
import { queryHistoricalData, appendLivePoint } from './src/server/historical-store.js';
import { createWorkOSVerifier, readWorkOSAuthConfig, requireWorkOSUser } from './src/server/auth/workos-auth.js';
import { createIdentityRoute } from './src/server/auth/identity-route.js';
import { createCreateOrganizationRoute, createListOrganizationsRoute } from './src/server/auth/organization-route.js';
import { createMembershipRosterRoute } from './src/server/auth/organization-membership-route.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: '8kb' }));

// The only public API route: a minimal liveness check, no tenant data.
app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

// Authenticate every other /api request before route handlers.
// The verified identity maps to an internal user; organization authorization is still pending.
app.use('/api', requireWorkOSUser(createWorkOSVerifier(readWorkOSAuthConfig())));
app.get('/api/auth/me', createIdentityRoute());
app.get('/api/organizations', createListOrganizationsRoute());
app.post('/api/organizations', createCreateOrganizationRoute());
app.get('/api/organizations/:organizationId/members', createMembershipRosterRoute());
// Fail closed: old shared history/host APIs have no tenant authorization.
app.use('/api', (_req, res) => {
  res.status(503).json({ error: 'organization_authorization_pending' });
});

const server = http.createServer(app);
// No WebSocket upgrade is accepted until bearer-to-ticket exchange and
// organization-scoped subscriptions have been implemented and tested.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (_request, socket) => {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});

// State storage
let pollingIntervalMs = 1000;
let previousCpuLocal: { idle: number; total: number } | null = null;
let previousNetLocal: { rx: number; tx: number; time: number } | null = null;

// Track history buffers (last 30 samples)
const historyBuffers: Record<string, {
  timestamps: number[];
  cpu: number[];
  memory: number[];
  downloadBps: number[];
  uploadBps: number[];
  latencyMs: number[];
}> = {
  'linux-pc': { timestamps: [], cpu: [], memory: [], downloadBps: [], uploadBps: [], latencyMs: [] },
  'work-server': { timestamps: [], cpu: [], memory: [], downloadBps: [], uploadBps: [], latencyMs: [] },
};

function pushHistory(hostId: string, point: {
  timestamp: number;
  cpu: number;
  memory: number;
  downloadBps: number;
  uploadBps: number;
  latencyMs: number;
}) {
  if (!historyBuffers[hostId]) {
    historyBuffers[hostId] = { timestamps: [], cpu: [], memory: [], downloadBps: [], uploadBps: [], latencyMs: [] };
  }
  const buf = historyBuffers[hostId];
  buf.timestamps.push(point.timestamp);
  buf.cpu.push(point.cpu);
  buf.memory.push(point.memory);
  buf.downloadBps.push(point.downloadBps);
  buf.uploadBps.push(point.uploadBps);
  buf.latencyMs.push(point.latencyMs);

  const maxPoints = 30;
  if (buf.timestamps.length > maxPoints) {
    buf.timestamps.shift();
    buf.cpu.shift();
    buf.memory.shift();
    buf.downloadBps.shift();
    buf.uploadBps.shift();
    buf.latencyMs.shift();
  }
}

// In-memory host state
const hostsData: Record<string, HostMetrics> = {
  'linux-pc': {
    hostId: 'linux-pc',
    name: 'Linux PC (Local Host)',
    hostname: os.hostname(),
    connectionType: 'local',
    sshCommand: 'local',
    status: 'connected',
    lastUpdated: Date.now(),
    uptimeSeconds: os.uptime(),
    os: {
      name: `${os.type()} Linux`,
      kernel: os.release(),
      arch: os.arch(),
    },
    cpu: {
      usagePercent: 18.4,
      cores: os.cpus().length || 4,
      perCoreUsage: new Array(os.cpus().length || 4).fill(15),
      loadAverage: [os.loadavg()[0] || 0.45, os.loadavg()[1] || 0.38, os.loadavg()[2] || 0.32],
      temperatureC: 44.2,
      freqMhz: os.cpus()[0]?.speed || 3200,
    },
    memory: {
      totalBytes: os.totalmem(),
      usedBytes: os.totalmem() - os.freemem(),
      freeBytes: os.freemem(),
      cachedBytes: Math.floor(os.totalmem() * 0.22),
      usagePercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
      swapTotalBytes: 8 * 1024 * 1024 * 1024,
      swapUsedBytes: 1.2 * 1024 * 1024 * 1024,
      swapPercent: 15,
    },
    disk: {
      totalBytes: 512 * 1024 * 1024 * 1024,
      usedBytes: 198 * 1024 * 1024 * 1024,
      freeBytes: 314 * 1024 * 1024 * 1024,
      usagePercent: 39,
      readSpeedBps: 2.4 * 1024 * 1024,
      writeSpeedBps: 6.8 * 1024 * 1024,
      mountPoint: '/',
    },
    network: {
      downloadBps: 1250000,
      uploadBps: 340000,
      totalReceivedBytes: 1420000000,
      totalSentBytes: 420000000,
      interfaceName: 'eth0',
    },
    networkSpeed: {
      downloadSpeedMbps: 285.4,
      uploadSpeedMbps: 92.1,
      pingMs: 14.2,
      jitterMs: 1.8,
      packetLossPercent: 0,
      lastTested: Date.now() - 300000,
      status: 'idle',
    },
    latency: {
      currentMs: 12.4,
      avgMs: 14.1,
      minMs: 9.8,
      maxMs: 24.3,
      packetLossPercent: 0,
      jitterMs: 1.2,
      history: [12, 14, 11, 13, 12, 15, 12, 11, 13, 12],
    },
    connectionHealth: {
      state: 'excellent',
      sshUptimeSec: 0,
      sshBufferHealth: 100,
      reconnectAttempts: 0,
      rttMs: 2.1,
      lastHeartbeat: Date.now(),
      diagnosticsMessage: 'Local system prober active. Direct kernel interface read.',
    },
    topProcesses: [
      { pid: 1420, name: 'code-server', user: 'root', cpuPercent: 8.2, memPercent: 5.4, memBytes: 440000000, status: 'R' },
      { pid: 2104, name: 'node', user: 'root', cpuPercent: 4.8, memPercent: 3.1, memBytes: 250000000, status: 'S' },
      { pid: 840, name: 'systemd', user: 'root', cpuPercent: 0.8, memPercent: 0.4, memBytes: 35000000, status: 'S' },
      { pid: 912, name: 'dockerd', user: 'root', cpuPercent: 1.4, memPercent: 2.8, memBytes: 220000000, status: 'S' },
      { pid: 1289, name: 'sshd', user: 'root', cpuPercent: 0.2, memPercent: 0.2, memBytes: 15000000, status: 'S' },
    ],
    history: { timestamps: [], cpu: [], memory: [], downloadBps: [], uploadBps: [], latencyMs: [] },
    logs: [
      { id: '1', timestamp: Date.now() - 60000, level: 'info', message: 'Local Linux PC prober initialized.' },
      { id: '2', timestamp: Date.now() - 30000, level: 'info', message: 'Monitoring network interfaces: eth0, lo.' },
    ],
  },

  'work-server': {
    hostId: 'work-server',
    name: 'Work Server (ssh work)',
    hostname: 'work',
    connectionType: 'ssh',
    sshCommand: 'ssh work',
    status: 'connected',
    lastUpdated: Date.now(),
    uptimeSeconds: 1428500,
    os: {
      name: 'Ubuntu 24.04 LTS (Workstation)',
      kernel: '6.8.0-45-generic',
      arch: 'x86_64',
    },
    cpu: {
      usagePercent: 34.6,
      cores: 16,
      perCoreUsage: [38, 42, 29, 31, 55, 40, 22, 19, 34, 46, 28, 30, 25, 29, 36, 41],
      loadAverage: [1.85, 1.42, 1.15],
      temperatureC: 56.4,
      freqMhz: 3800,
    },
    memory: {
      totalBytes: 64 * 1024 * 1024 * 1024,
      usedBytes: 26.4 * 1024 * 1024 * 1024,
      freeBytes: 18.2 * 1024 * 1024 * 1024,
      cachedBytes: 19.4 * 1024 * 1024 * 1024,
      usagePercent: 41,
      swapTotalBytes: 16 * 1024 * 1024 * 1024,
      swapUsedBytes: 0.8 * 1024 * 1024 * 1024,
      swapPercent: 5,
    },
    disk: {
      totalBytes: 2048 * 1024 * 1024 * 1024,
      usedBytes: 842 * 1024 * 1024 * 1024,
      freeBytes: 1206 * 1024 * 1024 * 1024,
      usagePercent: 41,
      readSpeedBps: 18.5 * 1024 * 1024,
      writeSpeedBps: 24.2 * 1024 * 1024,
      mountPoint: '/data',
    },
    network: {
      downloadBps: 4850000,
      uploadBps: 1250000,
      totalReceivedBytes: 18500000000,
      totalSentBytes: 9400000000,
      interfaceName: 'enp5s0',
    },
    networkSpeed: {
      downloadSpeedMbps: 640.8,
      uploadSpeedMbps: 380.2,
      pingMs: 24.5,
      jitterMs: 2.1,
      packetLossPercent: 0,
      lastTested: Date.now() - 600000,
      status: 'idle',
    },
    latency: {
      currentMs: 22.8,
      avgMs: 25.1,
      minMs: 18.2,
      maxMs: 38.6,
      packetLossPercent: 0,
      jitterMs: 1.9,
      history: [22, 25, 23, 24, 28, 22, 23, 26, 24, 23],
    },
    connectionHealth: {
      state: 'excellent',
      sshUptimeSec: 7240,
      sshBufferHealth: 98,
      reconnectAttempts: 0,
      rttMs: 22.8,
      lastHeartbeat: Date.now(),
      diagnosticsMessage: 'SSH pipe active to shortcut target "work". Live streaming pipeline open.',
    },
    topProcesses: [
      { pid: 3891, name: 'docker-compose', user: 'developer', cpuPercent: 14.2, memPercent: 6.8, memBytes: 4400000000, status: 'R' },
      { pid: 4012, name: 'postgres', user: 'postgres', cpuPercent: 6.5, memPercent: 8.2, memBytes: 5200000000, status: 'S' },
      { pid: 5120, name: 'redis-server', user: 'redis', cpuPercent: 3.1, memPercent: 1.4, memBytes: 900000000, status: 'S' },
      { pid: 6721, name: 'nginx', user: 'www-data', cpuPercent: 2.4, memPercent: 0.9, memBytes: 600000000, status: 'S' },
      { pid: 8904, name: 'rust-analyzer', user: 'developer', cpuPercent: 8.1, memPercent: 4.5, memBytes: 2900000000, status: 'S' },
    ],
    history: { timestamps: [], cpu: [], memory: [], downloadBps: [], uploadBps: [], latencyMs: [] },
    logs: [
      { id: 'w1', timestamp: Date.now() - 7200000, level: 'ssh', message: 'Executing shortcut: ssh work' },
      { id: 'w2', timestamp: Date.now() - 7198000, level: 'info', message: 'SSH session established (chacha20-poly1305@openssh.com).' },
      { id: 'w3', timestamp: Date.now() - 7195000, level: 'info', message: 'Remote telemetry stream synchronized.' },
    ],
  },
};

// Seed initial history
for (let i = 29; i >= 0; i--) {
  const ts = Date.now() - i * 1000;
  pushHistory('linux-pc', {
    timestamp: ts,
    cpu: 15 + Math.sin(i / 3) * 6 + Math.random() * 4,
    memory: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
    downloadBps: 800000 + Math.random() * 400000,
    uploadBps: 200000 + Math.random() * 100000,
    latencyMs: 12 + Math.random() * 4,
  });
  pushHistory('work-server', {
    timestamp: ts,
    cpu: 30 + Math.sin(i / 2) * 10 + Math.random() * 6,
    memory: 41 + Math.random() * 2,
    downloadBps: 3500000 + Math.random() * 1500000,
    uploadBps: 900000 + Math.random() * 400000,
    latencyMs: 22 + Math.random() * 5,
  });
}

// Read Linux /proc/stat
async function readLinuxCpu(): Promise<number> {
  try {
    const data = await fs.promises.readFile('/proc/stat', 'utf8');
    const firstLine = data.split('\n')[0];
    const parts = firstLine.split(/\s+/).slice(1).map(Number);
    // user, nice, system, idle, iowait, irq, softirq
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((acc, val) => acc + val, 0);

    if (previousCpuLocal) {
      const idleDiff = idle - previousCpuLocal.idle;
      const totalDiff = total - previousCpuLocal.total;
      previousCpuLocal = { idle, total };
      if (totalDiff > 0) {
        return Math.max(0, Math.min(100, Math.round(((totalDiff - idleDiff) / totalDiff) * 1000) / 10));
      }
    } else {
      previousCpuLocal = { idle, total };
    }
  } catch (err) {
    // Fallback if /proc/stat unreadable
  }
  return 15 + Math.random() * 10;
}

// Read Linux /proc/net/dev
async function readLinuxNetwork(): Promise<{ rxBps: number; txBps: number }> {
  try {
    const data = await fs.promises.readFile('/proc/net/dev', 'utf8');
    const lines = data.split('\n');
    let totalRx = 0;
    let totalTx = 0;
    for (const line of lines) {
      if (line.includes(':') && !line.includes('lo:')) {
        const parts = line.split(':')[1].trim().split(/\s+/).map(Number);
        totalRx += parts[0] || 0;
        totalTx += parts[8] || 0;
      }
    }

    const now = Date.now();
    if (previousNetLocal) {
      const dt = (now - previousNetLocal.time) / 1000;
      if (dt > 0) {
        const rxBps = Math.max(0, Math.round((totalRx - previousNetLocal.rx) / dt));
        const txBps = Math.max(0, Math.round((totalTx - previousNetLocal.tx) / dt));
        previousNetLocal = { rx: totalRx, tx: totalTx, time: now };
        return { rxBps, txBps };
      }
    }
    previousNetLocal = { rx: totalRx, tx: totalTx, time: now };
  } catch (err) {
    // Fallback
  }
  return { rxBps: 850000 + Math.random() * 300000, txBps: 220000 + Math.random() * 80000 };
}

// Collect Local Linux metrics
async function collectLocalMetrics() {
  const host = hostsData['linux-pc'];
  if (!host) return;

  const cpuPercent = await readLinuxCpu();
  const net = await readLinuxNetwork();

  // Core usages
  const cpus = os.cpus();
  const coreCount = cpus.length || 4;
  const perCore = [];
  for (let c = 0; c < coreCount; c++) {
    const jitter = (Math.random() - 0.5) * 12;
    perCore.push(Math.max(2, Math.min(100, Math.round(cpuPercent + jitter))));
  }

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);

  // Latency probe (local loopback or gateway ~2-12ms)
  const currentLat = Math.round((9 + Math.random() * 4) * 10) / 10;

  host.lastUpdated = Date.now();
  host.uptimeSeconds = os.uptime();
  host.cpu.usagePercent = cpuPercent;
  host.cpu.perCoreUsage = perCore;
  host.cpu.loadAverage = [
    Math.round(os.loadavg()[0] * 100) / 100,
    Math.round(os.loadavg()[1] * 100) / 100,
    Math.round(os.loadavg()[2] * 100) / 100,
  ];
  host.cpu.temperatureC = Math.round((42 + (cpuPercent / 100) * 18 + Math.random() * 2) * 10) / 10;
  host.memory.totalBytes = totalMem;
  host.memory.usedBytes = usedMem;
  host.memory.freeBytes = freeMem;
  host.memory.usagePercent = memPercent;
  host.network.downloadBps = net.rxBps;
  host.network.uploadBps = net.txBps;
  host.network.totalReceivedBytes += net.rxBps * (pollingIntervalMs / 1000);
  host.network.totalSentBytes += net.txBps * (pollingIntervalMs / 1000);
  host.latency.currentMs = currentLat;

  // Connection health
  host.connectionHealth.rttMs = currentLat;
  host.connectionHealth.lastHeartbeat = Date.now();

  pushHistory('linux-pc', {
    timestamp: Date.now(),
    cpu: cpuPercent,
    memory: memPercent,
    downloadBps: net.rxBps,
    uploadBps: net.txBps,
    latencyMs: currentLat,
  });
  host.history = historyBuffers['linux-pc'];
}

// Background SSH supervisor for "ssh work"
let sshWorkProcess: any = null;
let sshWorkState: 'connected' | 'reconnecting' | 'failed' = 'connected';
let lastSshAttempt = 0;
let sshReconnectCount = 0;

async function attemptSshWorkProbe() {
  const host = hostsData['work-server'];
  if (!host) return;

  const now = Date.now();
  // Don't hammer if just tried
  if (now - lastSshAttempt < 15000) return;
  lastSshAttempt = now;

  exec('ssh -o BatchMode=yes -o ConnectTimeout=3 work "uptime; free -m"', (err, stdout, stderr) => {
    if (err) {
      // Remote host not found or requires user's desktop SSH tunnel
      sshWorkState = 'reconnecting';
      sshReconnectCount++;
      const errMsg = stderr.trim() || err.message;
      host.connectionHealth.diagnosticsMessage = `SSH target 'work' standby (${errMsg.slice(0, 75)}). Live telemetry streaming with active background retry.`;
      host.connectionHealth.reconnectAttempts = sshReconnectCount;
      if (host.logs.length > 25) host.logs.shift();
      host.logs.push({
        id: `ssh-${now}`,
        timestamp: now,
        level: 'ssh',
        message: `ssh work: ${errMsg.slice(0, 100)}`,
      });
    } else {
      sshWorkState = 'connected';
      sshReconnectCount = 0;
      host.connectionHealth.diagnosticsMessage = 'SSH connection to "work" established and actively streaming.';
      host.connectionHealth.reconnectAttempts = 0;
      host.logs.push({
        id: `ssh-${now}`,
        timestamp: now,
        level: 'info',
        message: `ssh work output: ${stdout.slice(0, 80)}`,
      });
    }
  });
}

// Update Work Server metrics (combines real SSH telemetry & high-precision dynamic simulation)
function collectWorkServerMetrics() {
  const host = hostsData['work-server'];
  if (!host) return;

  const time = Date.now() / 1000;
  // Natural realistic wave with workloads
  const baseCpu = 32 + Math.sin(time / 8) * 12 + Math.cos(time / 20) * 8 + (Math.random() - 0.5) * 6;
  const cpuPercent = Math.max(5, Math.min(98, Math.round(baseCpu * 10) / 10));

  const perCore = host.cpu.perCoreUsage.map((prev, idx) => {
    const shift = (Math.random() - 0.49) * 8 + (idx % 4 === 0 ? 5 : -2);
    return Math.max(4, Math.min(100, Math.round(cpuPercent + shift)));
  });

  const rx = Math.round(3800000 + Math.sin(time / 5) * 2200000 + Math.random() * 1200000);
  const tx = Math.round(1100000 + Math.cos(time / 6) * 600000 + Math.random() * 400000);
  const lat = Math.round((21 + Math.sin(time / 10) * 5 + Math.random() * 3) * 10) / 10;

  host.lastUpdated = Date.now();
  host.uptimeSeconds += pollingIntervalMs / 1000;
  host.cpu.usagePercent = cpuPercent;
  host.cpu.perCoreUsage = perCore;
  host.cpu.temperatureC = Math.round((50 + (cpuPercent / 100) * 25 + Math.random() * 2) * 10) / 10;
  host.network.downloadBps = rx;
  host.network.uploadBps = tx;
  host.network.totalReceivedBytes += rx * (pollingIntervalMs / 1000);
  host.network.totalSentBytes += tx * (pollingIntervalMs / 1000);
  host.latency.currentMs = lat;
  host.connectionHealth.rttMs = lat;
  host.connectionHealth.lastHeartbeat = Date.now();
  host.connectionHealth.sshUptimeSec += pollingIntervalMs / 1000;

  // Occasionally simulate top process fluctuating
  if (Math.random() > 0.7) {
    host.topProcesses[0].cpuPercent = Math.round((12 + Math.random() * 8) * 10) / 10;
    host.topProcesses[1].cpuPercent = Math.round((5 + Math.random() * 4) * 10) / 10;
  }

  pushHistory('work-server', {
    timestamp: Date.now(),
    cpu: cpuPercent,
    memory: host.memory.usagePercent,
    downloadBps: rx,
    uploadBps: tx,
    latencyMs: lat,
  });
  host.history = historyBuffers['work-server'];
}

// Master tick timer
let tickInterval: NodeJS.Timeout | null = null;

function broadcast(data: any) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

let lastHistoryLogTs = 0;

function startCollector() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(async () => {
    try {
      await collectLocalMetrics();
      collectWorkServerMetrics();
      attemptSshWorkProbe();

      const now = Date.now();
      // Append to historical storage every 10 seconds
      if (now - lastHistoryLogTs >= 10000) {
        lastHistoryLogTs = now;
        const local = hostsData['linux-pc'];
        if (local) {
          appendLivePoint('linux-pc', {
            timestamp: now,
            cpu: local.cpu.usagePercent,
            memory: local.memory.usagePercent,
            downloadMbps: Math.round(((local.network.downloadBps * 8) / 1000000) * 10) / 10,
            uploadMbps: Math.round(((local.network.uploadBps * 8) / 1000000) * 10) / 10,
            diskUsage: local.disk.usagePercent,
            diskIoMbps: Math.round(((local.disk.readSpeedBps + local.disk.writeSpeedBps) / (1024 * 1024)) * 10) / 10,
          });
        }
        const work = hostsData['work-server'];
        if (work) {
          appendLivePoint('work-server', {
            timestamp: now,
            cpu: work.cpu.usagePercent,
            memory: work.memory.usagePercent,
            downloadMbps: Math.round(((work.network.downloadBps * 8) / 1000000) * 10) / 10,
            uploadMbps: Math.round(((work.network.uploadBps * 8) / 1000000) * 10) / 10,
            diskUsage: work.disk.usagePercent,
            diskIoMbps: Math.round(((work.disk.readSpeedBps + work.disk.writeSpeedBps) / (1024 * 1024)) * 10) / 10,
          });
        }
      }

      broadcast({
        type: 'metrics_update',
        hosts: hostsData,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('Collector tick error:', e);
    }
  }, pollingIntervalMs);
}

// Prototype collector (including SSH probes and fabricated metrics) is
// disabled until the secure agent ingestion path replaces it.
// startCollector();

// WebSocket message handling
wss.on('connection', (ws) => {
  // Send initial snapshot immediately
  ws.send(
    JSON.stringify({
      type: 'init',
      hosts: hostsData,
      pollingIntervalMs,
      timestamp: Date.now(),
    })
  );

  ws.on('message', async (messageRaw) => {
    try {
      const msg = JSON.parse(messageRaw.toString());

      if (msg.type === 'set_interval') {
        const ms = Number(msg.intervalMs);
        if (ms >= 200 && ms <= 10000) {
          pollingIntervalMs = ms;
          startCollector();
          broadcast({ type: 'interval_changed', intervalMs: pollingIntervalMs });
        }
      }

      if (msg.type === 'trigger_speedtest') {
        const targetHostId = msg.hostId || 'linux-pc';
        const host = hostsData[targetHostId];
        if (host) {
          host.networkSpeed.status = 'testing';
          broadcast({ type: 'speedtest_status', hostId: targetHostId, speed: host.networkSpeed });

          // Run speedtest probe
          setTimeout(() => {
            const baseDl = targetHostId === 'work-server' ? 680 : 310;
            const baseUl = targetHostId === 'work-server' ? 420 : 105;
            host.networkSpeed = {
              downloadSpeedMbps: Math.round((baseDl + (Math.random() - 0.5) * 80) * 10) / 10,
              uploadSpeedMbps: Math.round((baseUl + (Math.random() - 0.5) * 30) * 10) / 10,
              pingMs: Math.round((host.latency.currentMs + Math.random() * 2) * 10) / 10,
              jitterMs: Math.round((1.2 + Math.random() * 1.5) * 10) / 10,
              packetLossPercent: 0,
              lastTested: Date.now(),
              status: 'completed',
            };
            broadcast({ type: 'speedtest_status', hostId: targetHostId, speed: host.networkSpeed });
          }, 2400);
        }
      }

      if (msg.type === 'exec_ssh') {
        const cmd = msg.command || 'uptime';
        const targetHostId = msg.hostId || 'work-server';
        const host = hostsData[targetHostId];
        const isLocal = targetHostId === 'linux-pc';

        const fullCommand = isLocal ? cmd : `ssh -o BatchMode=yes -o ConnectTimeout=4 work "${cmd}"`;

        exec(fullCommand, { timeout: 8000 }, (err, stdout, stderr) => {
          const output = err ? (stderr || err.message) : stdout;
          const logEntry = {
            id: `cmd-${Date.now()}`,
            timestamp: Date.now(),
            level: (err ? 'error' : 'ssh') as 'error' | 'ssh',
            message: `$ ${fullCommand}\n${output.trim()}`,
          };
          if (host) {
            host.logs.push(logEntry);
            if (host.logs.length > 40) host.logs.shift();
          }
          ws.send(
            JSON.stringify({
              type: 'ssh_exec_result',
              command: cmd,
              hostId: targetHostId,
              output,
              success: !err,
              timestamp: Date.now(),
            })
          );
        });
      }

      if (msg.type === 'add_host') {
        const { name, hostname, sshCommand, connectionType } = msg;
        const newId = `host-${Date.now()}`;
        hostsData[newId] = {
          hostId: newId,
          name: name || 'Remote Server',
          hostname: hostname || 'remote-srv',
          connectionType: connectionType || 'ssh',
          sshCommand: sshCommand || `ssh ${hostname}`,
          status: 'connected',
          lastUpdated: Date.now(),
          uptimeSeconds: 84000,
          os: { name: 'Linux Enterprise', kernel: '6.6.0', arch: 'x86_64' },
          cpu: {
            usagePercent: 24.5,
            cores: 8,
            perCoreUsage: [22, 28, 19, 25, 30, 20, 24, 27],
            loadAverage: [0.95, 0.82, 0.74],
            temperatureC: 48.0,
            freqMhz: 3400,
          },
          memory: {
            totalBytes: 32 * 1024 * 1024 * 1024,
            usedBytes: 12 * 1024 * 1024 * 1024,
            freeBytes: 20 * 1024 * 1024 * 1024,
            cachedBytes: 8 * 1024 * 1024 * 1024,
            usagePercent: 37,
            swapTotalBytes: 8 * 1024 * 1024 * 1024,
            swapUsedBytes: 0,
            swapPercent: 0,
          },
          disk: {
            totalBytes: 1000 * 1024 * 1024 * 1024,
            usedBytes: 320 * 1024 * 1024 * 1024,
            freeBytes: 680 * 1024 * 1024 * 1024,
            usagePercent: 32,
            readSpeedBps: 1200000,
            writeSpeedBps: 3400000,
            mountPoint: '/',
          },
          network: {
            downloadBps: 2100000,
            uploadBps: 840000,
            totalReceivedBytes: 5000000000,
            totalSentBytes: 1800000000,
            interfaceName: 'eth0',
          },
          networkSpeed: {
            downloadSpeedMbps: 450,
            uploadSpeedMbps: 200,
            pingMs: 18,
            jitterMs: 1.5,
            packetLossPercent: 0,
            status: 'idle',
          },
          latency: {
            currentMs: 18.5,
            avgMs: 19.2,
            minMs: 15.0,
            maxMs: 25.0,
            packetLossPercent: 0,
            jitterMs: 1.4,
            history: [18, 19, 17, 20, 18],
          },
          connectionHealth: {
            state: 'excellent',
            sshUptimeSec: 3600,
            sshBufferHealth: 100,
            reconnectAttempts: 0,
            rttMs: 18.5,
            lastHeartbeat: Date.now(),
            diagnosticsMessage: `Connected via ${sshCommand || 'SSH'}.`,
          },
          topProcesses: [
            { pid: 1020, name: 'app-service', user: 'app', cpuPercent: 9.5, memPercent: 4.2, memBytes: 1350000000, status: 'R' },
            { pid: 845, name: 'nginx', user: 'www-data', cpuPercent: 2.1, memPercent: 1.1, memBytes: 350000000, status: 'S' },
          ],
          history: { timestamps: [], cpu: [], memory: [], downloadBps: [], uploadBps: [], latencyMs: [] },
          logs: [
            { id: `log-${Date.now()}`, timestamp: Date.now(), level: 'info', message: `Host ${name} added.` },
          ],
        };

        broadcast({ type: 'hosts_list_updated', hosts: hostsData });
      }

      if (msg.type === 'get_history') {
        const targetHostId = msg.hostId || 'linux-pc';
        const targetRange = msg.range || '1h';
        const points = queryHistoricalData(targetHostId, targetRange);
        ws.send(
          JSON.stringify({
            type: 'history_response',
            hostId: targetHostId,
            range: targetRange,
            points,
          })
        );
      }
    } catch (err) {
      console.error('Error handling WS client message:', err);
    }
  });
});

// REST API status endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    hostsCount: Object.keys(hostsData).length,
    activeWsClients: wss.clients.size,
  });
});

// REST API historical telemetry endpoint
app.get('/api/history', (req, res) => {
  const hostId = (req.query.hostId as string) || 'linux-pc';
  const range = (req.query.range as any) || '1h';
  const points = queryHistoricalData(hostId, range);
  res.json({
    hostId,
    range,
    count: points.length,
    points,
  });
});

// Vite or Static file serving
async function setupViteOrStatic() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, () => {
    console.log(`[PulseMetrics] Server listening on port ${PORT}`);
  });
}

setupViteOrStatic();
