import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { FrameBudget } from '../../src/core/frame-budget.js';
import { createSettingsStore } from '../../src/core/settings.js';

const source = readFileSync(new URL('../../src/testing/qa.js', import.meta.url), 'utf8');
const benchmarkStart = source.indexOf('  function benchmark(');
const benchmarkEnd = source.indexOf("  ui.button(ui.inspectionRow, 'Inspect area'", benchmarkStart);
const statsSource = source.slice(source.indexOf('function percentile('), source.indexOf('function createPanel('));
const scaleSource = source.slice(source.indexOf('  function applyReviewScale('), source.indexOf('  function restoreGameplayScale('));

// Run the actual QA lifecycle with a deterministic scene and animation clock.
// The controller is real; WebGL, gameplay fixtures and device timings are not.
function harness({ setupFails = false, longTasks = false } = {}) {
  assert.ok(benchmarkStart >= 0 && benchmarkEnd > benchmarkStart);
  const budget = new FrameBudget(), Settings = createSettingsStore({ initial: { quality: 'performance' } });
  const ui = { quality: { value: 'performance' }, renderScale: { value: '2' }, select: { value: 'street' } };
  const frames = new Map(), reports = [], snapshots = [], runtimeFrames = [], renderDeltas = [], deferred = [];
  let frameId = 0, clock = 0, simulated = 0, gpuSamples = 0, renderCount = 0;
  const renderer = {
    ratio: 2, info: { memory: { geometries: 20, textures: 8 }, programs: [1], render: { calls: 10, triangles: 200 } },
    domElement: { width: 800, height: 600, getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    getContext: () => ({ isContextLost: () => false }),
    getPixelRatio() { return this.ratio; },
    setPixelRatio(value) { this.ratio = value; }, setSize() {},
  };
  const fixture = {
    prepareFrame() {}, afterFrame: () => ({ alive: 4, attacking: 1 }), markMeasured() { simulated = 0; },
    measurement: () => ({ elapsed: simulated, shots: 12, hits: 8, kills: 2, respawns: 2, healthRestores: 1, absorbedDamage: 10 }),
  };
  const api = {
    setTesting(active) { if (!active) budget.reset(); },
    setInspection() {},
    stepFrame(dt) { clock += 18; simulated += dt; },
    render(dt) { renderDeltas.push(dt); clock += 5; if (++renderCount % 8 === 0) gpuSamples++; },
    metrics: () => ({}),
    resetRuntimeBudget: () => budget.reset(),
    recordRuntimeFrame(dt, simulationMs, renderMs, cpuMs, gpuMs) {
      runtimeFrames.push({ dt, simulationMs, renderMs, cpuMs, gpuMs });
      budget.sample(dt, { simulationMs, renderMs, cpuMs, gpuMs });
      renderer.ratio = budget.scale;
    },
    runtimeMetrics() { const result = budget.snapshot(); snapshots.push(result); return result; },
    gpuTimer: {
      reset() { gpuSamples = 0; }, setEnabled() {}, snapshot: () => ({ sampleCount: 0, status: 'stub' }),
      get totalSamples() { return gpuSamples; }, get latestMs() { return 4; },
    },
  };
  const context = {
    busy: false, disposed: false, inspectedActor: null, abortBenchmark: null,
    api, renderer, Settings, ui, Player: { yaw: 0, pitch: 0, health: 100 }, Input: { active: false },
    Weapons: { current: 'smg', _vm: () => ({}) }, WEAPON_DEFS: {}, BENCHMARK_MS: 10_000, WARMUP_MS: 500,
    ZONE_LABELS: { street: 'Street' }, getMissionState: () => ({ zone: 'street' }),
    performance: { now: () => clock }, innerWidth: 800, innerHeight: 600,
    document: { hidden: false, getElementById: () => null, addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {},
    setTimeout(callback, delay) { if (delay === 0) deferred.push(callback); return 1; }, clearTimeout() {},
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    assert: (condition, message) => assert.ok(condition, message), assertSilent() {},
    pauseSilently() { budget.reset(); }, setNPCInspection() {}, freshApartment() { budget.reset(); },
    prepareCombatFixture() { if (setupFails) throw new Error('fixture failed'); return fixture; },
    pausedRender() {}, graphicsDescription: () => [], handAssetDescription: () => 'Fixture hands',
    report(state, lines) { reports.push({ state, text: Array.isArray(lines) ? lines.join('\n') : lines }); },
    setBusy(value) { context.busy = value; },
    configureRenderer() { renderer.ratio = Settings.get('quality') === 'auto' ? budget.scale : 0.85; },
  };
  if (longTasks) context.PerformanceObserver = class {
    static supportedEntryTypes = ['longtask'];
    observe() {} disconnect() {} takeRecords() { return []; }
  };
  const benchmark = runInNewContext(`${statsSource}\n${scaleSource}\n${source.slice(benchmarkStart, benchmarkEnd)}; benchmark`, context);
  return {
    benchmark, budget, Settings, ui, renderer, reports, snapshots, runtimeFrames, renderDeltas, context,
    async flushLongTasks() { for (const callback of deferred) callback(); await Promise.resolve(); },
    complete() {
      for (let timestamp = 0; frames.size && timestamp <= 12_000; timestamp += 20) {
        const [id, callback] = frames.entries().next().value;
        frames.delete(id);
        callback(timestamp);
      }
      assert.equal(frames.size, 0, 'the benchmark must finish within its bounded measurement');
    },
  };
}

test('adaptive QA uses the real controller, snapshots once before reset and restores review settings', () => {
  const qa = harness();
  qa.benchmark({ adaptive: true });
  assert.equal(qa.Settings.get('quality'), 'auto');
  assert.equal(qa.ui.renderScale.value, 'device');
  qa.complete();
  assert.equal(qa.reports.at(-1).state, 'pass', qa.reports.at(-1).text);
  assert.equal(qa.snapshots.length, 1, 'runtime percentile snapshots must not run per frame');
  assert.ok(qa.snapshots[0].frame.sampleCount > 0);
  assert.equal(qa.snapshots[0].qualityTier, 2, 'measured CPU pressure reaches the production presentation controller');
  assert.equal(qa.budget.snapshot().frame.sampleCount, 0, 'normal cleanup resets recent runtime history');
  assert.ok(qa.runtimeFrames.length > 500);
  assert.ok(qa.runtimeFrames.slice(1).every(frame => frame.dt === 0.02 && frame.simulationMs === 18 && frame.renderMs === 5 && frame.cpuMs === 23));
  assert.ok(qa.runtimeFrames.some(frame => frame.gpuMs === null));
  assert.ok(qa.runtimeFrames.some(frame => frame.gpuMs === 4));
  assert.equal(qa.renderDeltas[1], 0.02, 'adaptive rendering receives elapsed time for normal shadow cadence');
  assert.equal(qa.Settings.get('quality'), 'performance');
  assert.equal(qa.ui.renderScale.value, '2');
  assert.equal(qa.renderer.ratio, 2);
  assert.match(qa.reports.at(-1).text, /not a physical-device test or proof of garbage collection/);
  assert.match(qa.reports.at(-1).text, /Runtime performance at measurement end/);
});

test('standard combat QA remains fixed and never drives runtime adaptation', () => {
  const qa = harness();
  qa.benchmark({ combat: true });
  qa.complete();
  assert.equal(qa.reports.at(-1).state, 'pass', qa.reports.at(-1).text);
  assert.equal(qa.runtimeFrames.length, 0);
  assert.equal(qa.snapshots.length, 0);
  assert.ok(qa.renderDeltas.every(value => value === undefined));
  assert.equal(qa.Settings.get('quality'), 'performance');
  assert.equal(qa.renderer.ratio, 2);
  assert.match(qa.reports.at(-1).text, /Render ratio held at the start value/);
});

test('adaptive QA restores the prior quality and explicit scale after fixture setup failure', () => {
  const qa = harness({ setupFails: true });
  qa.benchmark({ adaptive: true });
  assert.equal(qa.reports.at(-1).state, 'fail');
  assert.match(qa.reports.at(-1).text, /fixture failed/);
  assert.equal(qa.Settings.get('quality'), 'performance');
  assert.equal(qa.ui.renderScale.value, '2');
  assert.equal(qa.renderer.ratio, 2);
  assert.equal(qa.context.busy, false);
});

test('disposing an adaptive QA run restores saved graphics even when no report is delivered', () => {
  const qa = harness();
  qa.benchmark({ adaptive: true });
  qa.context.disposed = true;
  qa.context.abortBenchmark();
  assert.equal(qa.Settings.get('quality'), 'performance');
  assert.equal(qa.ui.renderScale.value, '2');
  assert.equal(qa.renderer.ratio, 0.85, 'disposed QA restores the preset without leaving a detached review override');
  assert.equal(qa.snapshots.length, 0);
});

test('disposal while the benchmark flushes long tasks cannot reapply a detached QA scale', async () => {
  const qa = harness({ longTasks: true });
  qa.benchmark({ adaptive: true });
  qa.complete();
  assert.equal(qa.context.abortBenchmark, null, 'the animation run has ended before the observer flush');
  qa.context.disposed = true;
  qa.context.api.setTesting(false);
  qa.context.configureRenderer();
  await qa.flushLongTasks();
  assert.equal(qa.Settings.get('quality'), 'performance');
  assert.equal(qa.renderer.ratio, 0.85);
  assert.equal(qa.reports.at(-1).state, 'running', 'no result is delivered to the removed panel');
});
