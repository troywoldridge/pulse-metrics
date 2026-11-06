# PulseMetrics 🚀

> **High-Precision Real-Time Server & Linux PC Monitoring Dashboard**
> Featuring tactile analog dials, SVG vector gauges, SSH streaming, WebSocket telemetry, historical trend analytics, statistical anomaly detection, and per-host threshold alerting.

---

## ✨ Features

- **Real-Time Dials & Gauges**:
  - **CPU Speedometer**: Sweeping analog needle dial with core load breakdowns, load averages, and thermal telemetry.
  - **Memory & Swap Concentric Gauge**: Multi-ring SVG gauge showing RAM and Swap utilization with cache statistics.
  - **Dual Bandwidth Dial**: Ingress and egress network throughput visualization in real-time.
  - **Disk I/O & Storage**: Live read/write throughput rates and mount-point capacity gauges.
  - **Latency & Connection Health**: Real-time ping jitter, RTT millisecond distribution, and SSH link diagnostics.
  - **Internet Speed Test**: Integrated on-demand bandwidth benchmarking (Download, Upload, Ping, Jitter).

- **Multi-Host & SSH Streaming**:
  - Monitors local Linux system (`linux-pc`) and remote target machines (`work-server` via shortcut `ssh work`).
  - Remote SSH console drawer with interactive shell command execution.
  - Automatic reconnection, heartbeat detection, and connection health rating (Excellent, Good, Degraded, Poor, Offline).

- **Historical Performance & Anomaly Analytics**:
  - Time ranges: **15m**, **1h**, **24h**, and **7d**.
  - **Linear Regression Trend Lines**: Directional slope trajectory analysis with % change.
  - **Rolling Z-Score Anomaly Detection**: Highlights statistical surges and plunges with configurable standard deviation sensitivity (1.8σ, 2.2σ, 3.0σ).
  - Interactive incident table with deviation magnitude and baseline comparisons.

- **Custom Alert Thresholds**:
  - User-configurable Warning and Critical thresholds for CPU, RAM, and Disk per host.
  - Colored alert zones on gauge dials (Normal, Warning, Critical arc bands).
  - Horizontal reference lines and shaded alert bands on historical charts.
  - Persistent state in `localStorage`.

- **Modern Architecture**:
  - Dark mode by default with light mode toggle.
  - Customizable widget layout and visibility modal.
  - Responsive layout built with React 19, TypeScript, Tailwind CSS v4, and Node.js WebSocket engine.

---

## 🛠️ Quick Start

### 1. Prerequisites
- **Node.js** (v20+ recommended)
- **OpenSSH Client** (for remote server SSH monitoring)

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 4. Build for Production
```bash
npm run build
npm start
```

---

## 🔒 Configuration & SSH Shortcuts

PulseMetrics connects to remote servers via OpenSSH or local probers:
- To use the `ssh work` shortcut, ensure your `~/.ssh/config` has a matching Host entry:
  ```sshconfig
  Host work
    HostName your.server.ip.or.domain
    User your_username
    IdentityFile ~/.ssh/id_ed25519
  ```

---

## 🧪 Testing

Run automated unit tests for math calculations and anomaly detection algorithms:
```bash
npx tsx --test src/utils/metrics-calculator.test.ts src/utils/anomaly-detector.test.ts
```

---

## 📄 License
Apache-2.0
