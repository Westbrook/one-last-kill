import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameTelemetry } from '../../src/core/frame-telemetry.js';

test('frame percentiles retain stalls and expose their count and maximum separately', () => {
  const telemetry = new FrameTelemetry();
  for (let i = 0; i < 98; i++) telemetry.record(0.01);
  telemetry.record(0.05);
  telemetry.record(0.25);
  const stats = telemetry.snapshot();
  assert.equal(stats.frame.p95Ms, 10);
  assert.equal(stats.frame.p99Ms, 50);
  assert.equal(stats.frame.maxMs, 250);
  assert.equal(stats.frame.meanMs, 12.8);
  assert.deepEqual(stats.longStalls, { totalCount: 2, recentCount: 2, maxMs: 250, thresholdMs: 50 });
});

test('timing storage is bounded and reused while lifetime stall evidence survives eviction', () => {
  const telemetry = new FrameTelemetry({ sampleWindow: 8 });
  const storage = telemetry.frame.values;
  telemetry.record(0.25);
  const timings = { cpuMs: 5, simulationMs: 2, renderMs: 3, gpuMs: 8 };
  for (let i = 0; i < 10000; i++) telemetry.record(1 / 60, timings);
  const stats = telemetry.snapshot();
  assert.equal(telemetry.frame.values, storage);
  assert.equal(storage.length, 8);
  for (const section of ['frame', 'cpu', 'simulation', 'render', 'gpu']) assert.equal(stats[section].sampleCount, 8);
  assert.equal(stats.longStalls.recentCount, 0);
  assert.equal(stats.longStalls.totalCount, 1);
  assert.equal(stats.longStalls.maxMs, 250);
  assert.equal(stats.frame.totalSamples, 10001);
});

test('missing measurements stay unknown and invalid work timings do not poison sections', () => {
  const telemetry = new FrameTelemetry();
  telemetry.record(1 / 60);
  telemetry.record(1 / 60, { cpuMs: 0, simulationMs: NaN, renderMs: -1, gpuMs: null });
  const stats = telemetry.snapshot();
  assert.equal(stats.cpu.meanMs, 0);
  assert.equal(stats.cpu.sampleCount, 1);
  assert.equal(stats.simulation.meanMs, null);
  assert.equal(stats.render.meanMs, null);
  assert.equal(stats.gpu.meanMs, null);
  assert.equal(stats.gpu.sampleCount, 0);
});

test('reset clears rolling metrics, retaining total samples and historical stalls', () => {
  const telemetry = new FrameTelemetry();
  telemetry.record(0.25, { cpuMs: 10, gpuMs: 15 });
  telemetry.reset();
  let stats = telemetry.snapshot();
  assert.equal(stats.frame.sampleCount, 0);
  assert.equal(stats.frame.totalSamples, 1);
  assert.equal(stats.cpu.meanMs, null);
  assert.equal(stats.gpu.meanMs, null);
  assert.equal(stats.longStalls.recentCount, 0);
  assert.equal(stats.longStalls.totalCount, 1);
  telemetry.record(0.01);
  stats = telemetry.snapshot();
  assert.equal(stats.frame.maxMs, 10);
  assert.equal(stats.frame.sampleCount, 1);
  assert.equal(stats.longStalls.maxMs, 250);
});
