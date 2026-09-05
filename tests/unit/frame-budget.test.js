import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameBudget, FixedStepClock } from '../../src/core/frame-budget.js';

test('paused time cannot become catch-up damage on resume', () => {
  const clock = new FixedStepClock();
  assert.equal(clock.advance(0.01, true), 1);
  assert.equal(clock.advance(100, false), 0);
  assert.equal(clock.advance(1 / 60, true), 2);
});
test('stalls have bounded work and invalid deltas are ignored', () => {
  const clock = new FixedStepClock();
  assert.equal(clock.advance(30, true), 8);
  assert.equal(clock.advance(NaN, true), 0);
  assert.equal(clock.advance(-1, true), 0);
});
const sampleFrames = (budget, count, dt, timings) => {
  for (let i = 0; i < count; i++) budget.sample(dt, timings);
};
const sampleUntilRevision = (budget, revision, dt) => {
  for (let i = 0; i < 20000 && budget.revision < revision; i++) budget.sample(dt);
  assert.equal(budget.revision, revision, 'a sustained workload must reach the expected quality revision');
};

test('adaptive scale targets 60 fps, respects bounds and waits for sustained pressure', () => {
  const budget = new FrameBudget();
  sampleFrames(budget, 60, 0.020);
  assert.equal(budget.scale, 1.2);
  sampleFrames(budget, 60, 0.020);
  assert.equal(budget.scale, 1.1, 'steady 20 ms frames exceed the 60 fps budget');
  sampleFrames(budget, 2000, 0.020);
  assert.equal(budget.scale, 0.7);
  sampleFrames(budget, 20000, 1 / 120);
  assert.equal(budget.scale, 1.4);
});

test('adaptive steps land exactly on the contact-shading boundary', () => {
  const budget = new FrameBudget();
  sampleUntilRevision(budget, 2, 1 / 30);
  assert.equal(budget.scale, 1, 'two downward steps must not prematurely disable contact shading');
  sampleUntilRevision(budget, 4, 1 / 120);
  assert.equal(budget.scale, 1.1, 'recovery uses stable hundredth increments');
});

test('recurring long stalls never buy quality upgrades on a fast display', () => {
  const budget = new FrameBudget();
  for (let i = 1; i <= 15000; i++) budget.sample(i % 120 === 0 ? 0.25 : 1 / 120);
  const stats = budget.snapshot();
  assert.equal(budget.scale, 1.2);
  assert.equal(stats.longStalls.totalCount, 125);
  assert.equal(stats.longStalls.maxMs, 250);
  assert.equal(stats.frame.maxMs, 250);
  assert.ok(stats.stallRecoverySeconds > 0);
  assert.equal(stats.bottleneck, 'none', 'interval stalls alone do not establish CPU or GPU attribution');
});

test('an isolated stall keeps its full evidence without forcing graphics down', () => {
  const budget = new FrameBudget();
  budget.sample(8);
  sampleFrames(budget, 1000, 1 / 120);
  assert.equal(budget.scale, 1.2);
  assert.equal(budget.revision, 0);
  assert.equal(budget.snapshot().longStalls.maxMs, 8000);
  sampleFrames(budget, 1500, 1 / 120);
  assert.ok(budget.scale > 1.2, 'stable delivery eventually recovers after the stall cooldown');
});

test('CPU pressure reduces presentation complexity before resolution', () => {
  const budget = new FrameBudget();
  const timings = { cpuMs: 18, simulationMs: 12, renderMs: 6, gpuMs: 4 };
  sampleFrames(budget, 120, 0.02, timings);
  assert.equal(budget.scale, 1.2);
  assert.equal(budget.qualityTier, 1);
  assert.equal(budget.revision, 1, 'tier-only changes are visible to consumers');
  assert.equal(budget.snapshot().bottleneck, 'cpu');
  sampleFrames(budget, 300, 0.02, timings);
  assert.equal(budget.qualityTier, 2);
  assert.equal(budget.scale, 1.2, 'lowering pixels cannot fix measured CPU work');
  assert.equal(budget.revision, 2, 'an exhausted presentation budget does not churn resources');
});

test('render-heavy callback wall time without GPU measurements can reduce resolution', () => {
  const budget = new FrameBudget();
  const timings = { cpuMs: 18, simulationMs: 2, renderMs: 16, gpuMs: null };
  sampleFrames(budget, 120, 0.02, timings);
  assert.equal(budget.snapshot().bottleneck, 'unknown', 'render wall time is not proof of CPU-only pressure');
  assert.equal(budget.scale, 1.1);
  assert.equal(budget.qualityTier, 1, 'uncertain render pressure can benefit from fewer draws as well as fewer pixels');
  sampleFrames(budget, 1000, 0.02, timings);
  assert.equal(budget.scale, 0.7, 'continued slow delivery is not permanently locked at the original resolution');
  assert.equal(budget.qualityTier, 2);
});

test('clearly simulation-heavy work keeps CPU attribution when GPU timing is unavailable', () => {
  const budget = new FrameBudget();
  sampleFrames(budget, 500, 0.02, { cpuMs: 18, simulationMs: 16, renderMs: 2 });
  assert.equal(budget.snapshot().bottleneck, 'cpu');
  assert.equal(budget.qualityTier, 2);
  assert.equal(budget.scale, 1.2, 'simulation-dominated work still uses the presentation budget first');
});

test('an unsplit callback measurement cannot establish CPU-only pressure without GPU data', () => {
  const budget = new FrameBudget();
  sampleFrames(budget, 120, 0.02, { cpuMs: 18 });
  assert.equal(budget.snapshot().bottleneck, 'unknown');
  assert.equal(budget.scale, 1.1);
  assert.equal(budget.qualityTier, 1);
});

test('measured GPU headroom distinguishes CPU render work from unknown render waits', () => {
  const budget = new FrameBudget();
  sampleFrames(budget, 500, 0.02, { cpuMs: 18, simulationMs: 2, renderMs: 16, gpuMs: 4 });
  assert.equal(budget.snapshot().bottleneck, 'cpu');
  assert.equal(budget.qualityTier, 2);
  assert.equal(budget.scale, 1.2);
});

test('CPU presentation tiers recover cautiously before adding resolution', () => {
  const budget = new FrameBudget();
  sampleFrames(budget, 250, 0.02, { cpuMs: 18, gpuMs: 4 });
  assert.equal(budget.qualityTier, 2);
  const healthy = { cpuMs: 3, gpuMs: 4 };
  const changes = [];
  let revision = budget.revision;
  for (let frame = 0; frame < 4000 && changes.length < 3; frame++) {
    budget.sample(1 / 120, healthy);
    if (budget.revision === revision) continue;
    changes.push({ tier: budget.qualityTier, scale: budget.scale });
    revision = budget.revision;
  }
  assert.deepEqual(changes, [
    { tier: 1, scale: 1.2 }, { tier: 0, scale: 1.2 }, { tier: 0, scale: 1.25 },
  ]);
});

test('one recovery-inhibited frame invalidates its whole window and requires eight fresh clean windows', () => {
  const budget = new FrameBudget();
  // Binary-exact frame intervals make each decision window precisely 64 frames.
  const dt = 1 / 64, healthy = { cpuMs: 3, gpuMs: 4 };
  sampleFrames(budget, 7 * 64 + 32, dt, healthy);
  assert.equal(budget.fastWindows, 7);
  budget.sample(dt, { ...healthy, allowRecovery: false });
  assert.equal(budget.fastWindows, 0, 'sensitive activity immediately clears accumulated recovery');
  sampleFrames(budget, 31, dt, healthy);
  assert.equal(budget.fastWindows, 0, 'the remaining healthy frames cannot earn a partially inhibited window');
  assert.equal(budget.scale, 1.2);
  assert.equal(budget.snapshot().frame.totalSamples, 8 * 64, 'inhibited recovery still records performance');
  sampleFrames(budget, 8 * 64 - 1, dt, healthy);
  assert.equal(budget.scale, 1.2, 'prior healthy time cannot shorten the new recovery period');
  budget.sample(dt, healthy);
  assert.equal(budget.scale, 1.25, 'omitting the optional field allows recovery after eight complete clean windows');
});

test('recovery inhibition preserves both load-driven reductions and the chosen presentation tier', () => {
  const gpu = new FrameBudget();
  sampleFrames(gpu, 120, 0.02, { cpuMs: 3, gpuMs: 18, allowRecovery: false });
  assert.equal(gpu.scale, 1.1, 'combat cannot delay needed resolution reductions');
  const cpu = new FrameBudget();
  sampleFrames(cpu, 250, 0.02, { cpuMs: 18, gpuMs: 4, allowRecovery: false });
  assert.equal(cpu.qualityTier, 2, 'combat cannot delay needed presentation reductions');
  const healthyCombat = { cpuMs: 3, gpuMs: 4, allowRecovery: false };
  sampleFrames(gpu, 4000, 1 / 120, healthyCombat);
  sampleFrames(cpu, 4000, 1 / 120, healthyCombat);
  assert.equal(gpu.scale, 1.1);
  assert.equal(cpu.qualityTier, 2, 'faster combat frames cannot restore expensive effects');
  assert.equal(gpu.fastWindows, 0);
  assert.equal(cpu.fastWindows, 0);
});

test('GPU and mixed pressure have distinct attribution and presentation changes', () => {
  const gpu = new FrameBudget();
  sampleFrames(gpu, 120, 0.02, { cpuMs: 3, gpuMs: 18 });
  assert.equal(gpu.scale, 1.1);
  assert.equal(gpu.qualityTier, 0);
  assert.equal(gpu.snapshot().bottleneck, 'gpu');
  const mixed = new FrameBudget();
  sampleFrames(mixed, 120, 0.02, { cpuMs: 18, gpuMs: 18 });
  assert.equal(mixed.scale, 1.1);
  assert.equal(mixed.qualityTier, 1);
  assert.equal(mixed.snapshot().bottleneck, 'mixed');
});

test('high refresh is an explicit budget and changing target resets accumulated pressure', () => {
  const standard = new FrameBudget();
  const highRefresh = new FrameBudget({ targetFps: 120 });
  sampleFrames(standard, 200, 1 / 60);
  sampleFrames(highRefresh, 200, 1 / 60);
  assert.equal(standard.scale, 1.2);
  assert.equal(highRefresh.scale, 1.1);
  highRefresh.setTargetFps(60);
  const previousScale = highRefresh.scale;
  sampleFrames(highRefresh, 100, 1 / 60);
  assert.equal(highRefresh.scale, previousScale);
  assert.equal(highRefresh.snapshot().targetFps, 60);
});

test('brief recoveries cannot reverse a quality reduction or repeatedly resize buffers', () => {
  const budget = new FrameBudget();
  for (let cycle = 0; cycle < 12; cycle++) {
    sampleFrames(budget, 150, 0.02);
    const reducedScale = budget.scale;
    sampleFrames(budget, 360, 1 / 120);
    assert.equal(budget.scale, reducedScale);
  }
  assert.equal(budget.scale, 0.7);
  assert.equal(budget.revision, 5);
});

test('pause resets recent windows without losing session stalls or chosen quality', () => {
  const budget = new FrameBudget();
  sampleFrames(budget, 120, 0.02);
  budget.sample(0.25);
  const scale = budget.scale;
  const revision = budget.revision;
  budget.reset();
  budget.sample(0); // The integration skips elapsed background time on resume.
  sampleFrames(budget, 20, 1 / 60);
  const stats = budget.snapshot();
  assert.equal(budget.scale, scale);
  assert.equal(budget.revision, revision);
  assert.equal(stats.frame.sampleCount, 20);
  assert.equal(stats.longStalls.recentCount, 0);
  assert.equal(stats.longStalls.totalCount, 1);
  assert.equal(stats.longStalls.maxMs, 250);
});

test('invalid intervals cannot contaminate telemetry or cause a quality decision', () => {
  const budget = new FrameBudget();
  for (const dt of [NaN, Infinity, -1, 0, Number.MAX_VALUE]) budget.sample(dt);
  assert.equal(budget.snapshot().frame.sampleCount, 0);
  assert.equal(budget.revision, 0);
});

test('fixed quality presets collect telemetry without changing automatic quality or history', () => {
  const budget = new FrameBudget();
  sampleFrames(budget, 1000, 1 / 30, { adaptive: false, cpuMs: 25, gpuMs: 24 });
  assert.equal(budget.scale, 1.2);
  assert.equal(budget.qualityTier, 0);
  assert.equal(budget.revision, 0);
  assert.equal(budget.snapshot().cpu.meanMs, 25);
  assert.equal(budget.snapshot().frame.totalSamples, 1000);
  sampleFrames(budget, 60, 0.020);
  assert.equal(budget.scale, 1.2, 'disabled adaptation cannot contribute a slow decision window');
});
