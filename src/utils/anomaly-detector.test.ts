import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTrendLine,
  calculateMovingAverage,
  detectAnomalies,
  TimeSeriesPoint,
} from './anomaly-detector';

test('calculateTrendLine computes slope and directional trends', () => {
  // Upward trend
  const risingPoints: TimeSeriesPoint[] = [
    { timestamp: 1000, value: 20 },
    { timestamp: 2000, value: 30 },
    { timestamp: 3000, value: 40 },
    { timestamp: 4000, value: 50 },
    { timestamp: 5000, value: 60 },
  ];
  const risingRes = calculateTrendLine(risingPoints);
  assert.equal(risingRes.direction, 'rising');
  assert.ok(risingRes.percentChange > 0);
  assert.equal(risingRes.points.length, 5);

  // Downward trend
  const fallingPoints: TimeSeriesPoint[] = [
    { timestamp: 1000, value: 80 },
    { timestamp: 2000, value: 60 },
    { timestamp: 3000, value: 40 },
    { timestamp: 4000, value: 20 },
  ];
  const fallingRes = calculateTrendLine(fallingPoints);
  assert.equal(fallingRes.direction, 'falling');
  assert.ok(fallingRes.percentChange < 0);

  // Flat/stable trend
  const flatPoints: TimeSeriesPoint[] = [
    { timestamp: 1000, value: 50 },
    { timestamp: 2000, value: 50.5 },
    { timestamp: 3000, value: 49.8 },
    { timestamp: 4000, value: 50.1 },
  ];
  const flatRes = calculateTrendLine(flatPoints);
  assert.equal(flatRes.direction, 'stable');
});

test('calculateMovingAverage smooths series points', () => {
  const points: TimeSeriesPoint[] = [
    { timestamp: 1000, value: 10 },
    { timestamp: 2000, value: 20 },
    { timestamp: 3000, value: 30 },
    { timestamp: 4000, value: 40 },
  ];
  const sma = calculateMovingAverage(points, 2);
  assert.equal(sma.length, 4);
  assert.equal(sma[0].value, 10);
  assert.equal(sma[1].value, 15); // (10+20)/2
  assert.equal(sma[2].value, 25); // (20+30)/2
  assert.equal(sma[3].value, 35); // (30+40)/2
});

test('detectAnomalies catches severe spikes and drops', () => {
  // Baseline ~20 with a massive spike to 95 at index 7
  const normalPoints: TimeSeriesPoint[] = [];
  for (let i = 0; i < 15; i++) {
    const val = i === 7 ? 95 : 20 + Math.sin(i) * 2;
    normalPoints.push({ timestamp: 1000 * (i + 1), value: val });
  }

  const anomalies = detectAnomalies(normalPoints, { thresholdSigma: 2.2, metricName: 'CPU', unit: '%' });
  assert.ok(anomalies.length >= 1);
  const found = anomalies.find((a) => a.value === 95);
  assert.ok(found);
  assert.equal(found?.type, 'spike');
  assert.equal(found?.severity, 'high');
  assert.ok(found?.description.includes('CPU surge to 95%'));
});
