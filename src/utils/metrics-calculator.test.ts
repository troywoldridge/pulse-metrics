import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatBitsPerSec,
  formatDuration,
  clamp,
  valueToDialAngle,
  polarToCartesian,
  describeArc,
  computeConnectionHealth,
  getSeverity,
  calculateThresholdBands,
} from './metrics-calculator';

test('formatBytes converts bytes to readable units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1024 * 1024 * 5.5), '5.5 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 32), '32 GB');
});

test('formatBitsPerSec formats network speed correctly', () => {
  assert.equal(formatBitsPerSec(0), '0 bps');
  assert.equal(formatBitsPerSec(1000), '1 Kbps');
  assert.equal(formatBitsPerSec(1000 * 1000 * 125), '125 Mbps');
  assert.equal(formatBitsPerSec(1000 * 1000 * 1000 * 1.5), '1.5 Gbps');
});

test('formatDuration formats seconds accurately', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(3665), '1h 1m 5s');
  assert.equal(formatDuration(90000), '1d 1h 0m');
});

test('clamp restricts values within min and max', () => {
  assert.equal(clamp(50, 0, 100), 50);
  assert.equal(clamp(-10, 0, 100), 0);
  assert.equal(clamp(150, 0, 100), 100);
});

test('valueToDialAngle maps range to degrees with custom sweeps', () => {
  // startAngle -135, sweep 270 (ends at +135)
  assert.equal(valueToDialAngle(0, 0, 100, -135, 270), -135);
  assert.equal(valueToDialAngle(50, 0, 100, -135, 270), 0);
  assert.equal(valueToDialAngle(100, 0, 100, -135, 270), 135);
});

test('polarToCartesian produces expected coordinates', () => {
  // Center 100, 100, radius 50. Angle 0 (top) -> x = 100, y = 50
  const top = polarToCartesian(100, 100, 50, 0);
  assert.ok(Math.abs(top.x - 100) < 0.001);
  assert.ok(Math.abs(top.y - 50) < 0.001);

  // Angle 90 (right) -> x = 150, y = 100
  const right = polarToCartesian(100, 100, 50, 90);
  assert.ok(Math.abs(right.x - 150) < 0.001);
  assert.ok(Math.abs(right.y - 100) < 0.001);
});

test('describeArc returns valid SVG path commands', () => {
  const path = describeArc(100, 100, 50, -135, 135);
  assert.ok(path.startsWith('M'));
  assert.ok(path.includes('A 50 50'));
});

test('computeConnectionHealth evaluates network state', () => {
  assert.equal(computeConnectionHealth(20, 0, 0, 'connected'), 'excellent');
  assert.equal(computeConnectionHealth(80, 0, 0, 'connected'), 'good');
  assert.equal(computeConnectionHealth(150, 0, 0, 'connected'), 'degraded');
  assert.equal(computeConnectionHealth(300, 15, 4, 'connected'), 'poor');
  assert.equal(computeConnectionHealth(0, 0, 0, 'disconnected'), 'offline');
});

test('getSeverity assigns normal, warning, critical properly', () => {
  assert.equal(getSeverity(50, 75, 90), 'normal');
  assert.equal(getSeverity(78, 75, 90), 'warning');
  assert.equal(getSeverity(95, 75, 90), 'critical');
});

test('calculateThresholdBands generates correct normal, warning, and critical arc bands', () => {
  const bands = calculateThresholdBands(100, 50, 0, 100, 70, 90, -135, 270);
  assert.equal(bands.length, 3);
  assert.equal(bands[0].zone, 'normal');
  assert.equal(bands[1].zone, 'warning');
  assert.equal(bands[2].zone, 'critical');
  assert.ok(bands[0].arcPath.startsWith('M'));
  assert.ok(bands[1].arcPath.startsWith('M'));
  assert.ok(bands[2].arcPath.startsWith('M'));
  assert.equal(bands[0].color, '#10b981');
  assert.equal(bands[1].color, '#f59e0b');
  assert.equal(bands[2].color, '#ef4444');
});

