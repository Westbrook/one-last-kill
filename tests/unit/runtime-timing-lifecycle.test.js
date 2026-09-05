import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { FixedStepClock, FrameBudget } from '../../src/core/frame-budget.js';
import { createFrameSampleCadence } from '../../src/core/frame-sample-cadence.js';
import { createGpuFrameTimer } from '../../src/core/gpu-frame-timer.js';

const source = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
const noOp = () => {};

function actualFunction(name) {
  const found = source.match(new RegExp('^function ' + name + '\\([^]*?^\\}', 'm'))?.[0];
  assert.ok(found, 'Keep the actual main function fixture current: ' + name);
  return found;
}

function actualDeclaration(name) {
  const found = source.match(new RegExp('^(?:const|let) ' + name + '\\b[^]*?;', 'm'))?.[0];
  assert.ok(found, 'Keep the actual main state fixture current: ' + name);
  return found;
}

function actualQaMethod(name) {
  const found = source.match(new RegExp('^      ' + name + '\\([^]*?^      },', 'm'))?.[0];
  assert.ok(found, 'Keep the actual QA method fixture current: ' + name);
  return found;
}

// Both real timer instances share one recording WebGL target. An illegal
// overlap is recorded even if the timer catches the resulting driver error.
function gpuContext() {
  const extension = { TIME_ELAPSED_EXT: 35007, GPU_DISJOINT_EXT: 36795, QUERY_COUNTER_BITS_EXT: 34916 };
  const queries = [], violations = [];
  let active = null;
  const gl = {
    QUERY_RESULT_AVAILABLE: 34919, QUERY_RESULT: 34918,
    getExtension: () => extension, getQuery: () => 64, getParameter: () => false,
    isContextLost: () => false,
    createQuery() {
      const query = { id: queries.length, available: false, deleted: false, result: 4e6 };
      queries.push(query);
      return query;
    },
    beginQuery(target, query) {
      if (active !== null) { violations.push('overlapping elapsed queries'); throw new Error('query overlap'); }
      assert.equal(target, extension.TIME_ELAPSED_EXT);
      assert.equal(query.deleted, false);
      query.available = false;
      active = query;
    },
    endQuery(target) {
      if (active === null) { violations.push('ending an inactive query'); throw new Error('no active query'); }
      assert.equal(target, extension.TIME_ELAPSED_EXT);
      active = null;
    },
    getQueryParameter(query, parameter) {
      assert.equal(query.deleted, false);
      assert.notEqual(query, active, 'An active query must never be polled');
      if (parameter === gl.QUERY_RESULT_AVAILABLE) return query.available;
      assert.equal(parameter, gl.QUERY_RESULT);
      assert.equal(query.available, true, 'An unfinished query must never be read');
      return query.result;
    },
    deleteQuery(query) {
      assert.notEqual(query, active, 'End an active query before releasing it');
      assert.equal(query.deleted, false);
      query.deleted = true;
    },
  };
  return { gl, queries, violations, get active() { return active; } };
}

function harness(t) {
  const listeners = new Map(), timings = [], fps = [], simulation = [], renders = [], audio = [];
  const gpu = gpuContext(), budget = new FrameBudget();
  const runtimeTimer = createGpuFrameTimer(gpu.gl, { enabled: true, maxQueries: 2 });
  const qaTimer = createGpuFrameTimer(gpu.gl);
  t.after(() => { runtimeTimer.dispose(); qaTimer.dispose(); });
  let cpuNow = 0;
  const document = {
    hidden: false,
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
  };
  const Input = { active: true, pollGamepad: noOp };
  const audioScene = { threat: 0 };
  const bindings = {
    FixedStepClock, createFrameSampleCadence, document, Input, audioScene,
    RunSettings: { isStarted: () => true }, PlayerState: { dead: false },
    IntroCard: { isOpen: () => false }, Endings: { isResolved: () => false },
    DefenseDirector: { isResolved: () => false },
    Settings: { get: () => 'auto' },
    performance: { now: () => ++cpuNow },
    syncTouchContext: noOp,
    stepFrame: dt => simulation.push(dt),
    render: dt => renders.push(dt ?? 0),
    updateAudioScene: dt => audio.push(dt),
    FPSMeter: { tick: (now, dt) => fps.push({ now, dt }) },
    recordRenderTime(dt, state) { timings.push({ dt, ...state }); budget.sample(dt, state); },
    resetRenderBudget: () => budget.reset(),
    gpuTimer: qaTimer,
  };
  const pauseHook = source.match(/^document\.addEventListener\('playstatechange', event => \{[^]*?^\}\);/m)?.[0];
  assert.ok(pauseHook, 'Execute the actual play-state subscription');
  const declarations = ['clock', 'contextLost', 'previousTime', 'wasPlaying', 'controlledTest', 'inspecting',
    'pauseRenderPending', 'runtimeGpuTimer', 'gpuCadence', 'lastGpuSample', 'frameTimings'].map(actualDeclaration).join('\n');
  const api = runInNewContext(declarations + '\n'
    + ['isPlaying', 'resetRuntimeTiming', 'frame'].map(actualFunction).join('\n') + '\n' + pauseHook
    + '\nconst qa = {' + ['setTesting', 'render', 'recordRuntimeFrame'].map(actualQaMethod).join('\n') + '};'
    + '\n;({frame,qa,setGpu(timer){runtimeGpuTimer=timer;},state(){return {previousTime,wasPlaying,pauseRenderPending,controlledTest};}});',
  bindings, { filename: 'src/main.js:runtime-timing-lifecycle' });
  api.setGpu(runtimeTimer);
  return {
    ...api, gpu, budget, runtimeTimer, qaTimer, timings, fps, simulation, renders, audio, audioScene, document, Input,
    pause() { Input.active = false; document.dispatchEvent({ type: 'playstatechange', detail: { active: false } }); },
    resume() { Input.active = true; document.dispatchEvent({ type: 'playstatechange', detail: { active: true } }); },
  };
}

test('pause and resume without an intervening RAF discard hidden duration and pending GPU results', t => {
  const h = harness(t);
  h.frame(1000);
  h.frame(1017);
  assert.equal(h.budget.snapshot().frame.sampleCount, 1);
  const stale = h.gpu.queries[0];
  assert.equal(h.runtimeTimer.snapshot().pendingQueries, 1);

  h.pause();
  assert.equal(stale.deleted, true, 'The actual event hook releases pending GPU work synchronously');
  assert.equal(h.runtimeTimer.snapshot().pendingQueries, 0);
  assert.equal(h.state().previousTime, 0);
  assert.equal(h.state().wasPlaying, false);
  assert.equal(h.budget.snapshot().frame.sampleCount, 0);
  stale.available = true; stale.result = 999e6;
  h.resume();
  h.frame(90000);
  assert.equal(h.simulation.at(-1), 0, 'The first resumed simulation receives no hidden duration');
  assert.equal(h.fps.at(-1).dt, 0, 'The FPS meter also discards the hidden interval');
  assert.equal(h.timings.at(-1).dt, 0);
  assert.equal(h.timings.at(-1).gpuMs, null);
  assert.equal(h.budget.snapshot().frame.sampleCount, 0, 'A zero-delta resumed render does not enter telemetry');
  assert.equal(h.budget.snapshot().longStalls.totalCount, 0);
  assert.equal(h.gpu.queries.length, 2, 'GPU cadence restarts on the fresh resumed render');

  h.frame(90017);
  assert.equal(h.timings.at(-1).dt, 0.017);
  assert.equal(h.budget.snapshot().frame.sampleCount, 1);
  assert.equal(h.budget.snapshot().frame.maxMs, 17);
  assert.equal(h.budget.snapshot().gpu.sampleCount, 0, 'Deleted results cannot leak into the new window');
  assert.deepEqual(h.gpu.violations, []);
});

test('actual runtime and QA frame submissions permit recovery only when the current threat is zero', t => {
  const h = harness(t);
  h.frame(1000);
  h.audioScene.threat = 0.01;
  h.frame(1017);
  assert.equal(h.timings.at(-1).allowRecovery, false, 'Even a small current threat blocks a quality increase');
  h.audioScene.threat = 0;
  h.frame(1034);
  assert.equal(h.timings.at(-1).allowRecovery, true, 'A quiet frame updates the reused timing record');

  h.qa.setTesting(true);
  h.audioScene.threat = 0.4;
  h.qa.recordRuntimeFrame(1 / 60, 2, 3, 5, 4);
  assert.equal(h.timings.at(-1).allowRecovery, false, 'QA measurements use the same recovery gate');
  h.audioScene.threat = 0;
  h.qa.recordRuntimeFrame(1 / 60, 2, 3, 5, 4);
  assert.equal(h.timings.at(-1).allowRecovery, true);
});

test('a paused RAF renders the pause state once and never restarts GPU timing', t => {
  const h = harness(t);
  h.frame(1000); h.frame(1017);
  const rendered = h.renders.length, samples = h.timings.length, allocated = h.gpu.queries.length;
  h.pause();
  assert.equal(h.state().pauseRenderPending, true);
  h.frame(50000);
  assert.equal(h.renders.length, rendered + 1, 'Synchronous reset preserves one pending pause render');
  assert.equal(h.audio.at(-1), 0);
  assert.equal(h.state().pauseRenderPending, false);
  h.frame(60000);
  assert.equal(h.renders.length, rendered + 1);
  assert.equal(h.timings.length, samples);
  assert.equal(h.gpu.queries.length, allocated);
  assert.equal(h.runtimeTimer.snapshot().allocatedQueries, 0);
});

test('a RAF-detected pause also clears timing when no play-state event was delivered', t => {
  const h = harness(t);
  h.frame(1000); h.frame(1017);
  const stale = h.gpu.queries[0];
  h.document.hidden = true;
  h.frame(70000);
  assert.equal(stale.deleted, true);
  assert.equal(h.budget.snapshot().frame.sampleCount, 0);
  h.document.hidden = false;
  h.frame(90000);
  assert.equal(h.fps.at(-1).dt, 0);
  assert.equal(h.budget.snapshot().longStalls.totalCount, 0);
  assert.equal(h.runtimeTimer.status, 'ready');
});

test('actual QA boundaries isolate runtime GPU queries and resume with a fresh frame', t => {
  const h = harness(t);
  h.frame(1000); h.frame(1017);
  const runtimeQuery = h.gpu.queries[0];
  h.qa.setTesting(true);
  assert.equal(runtimeQuery.deleted, true);
  assert.equal(h.runtimeTimer.snapshot().allocatedQueries, 0);
  assert.equal(h.budget.snapshot().frame.sampleCount, 0);
  const automaticRenders = h.renders.length, automaticSamples = h.timings.length;

  h.qaTimer.setEnabled(true);
  h.qa.render(1 / 60);
  const qaQuery = h.gpu.queries.at(-1);
  assert.equal(h.qaTimer.snapshot().pendingQueries, 1);
  assert.equal(h.gpu.active, null, 'QA completes its query before yielding to another callback');
  h.frame(50000);
  assert.equal(h.renders.length, automaticRenders + 1, 'Controlled mode only renders when QA explicitly asks');
  assert.equal(h.timings.length, automaticSamples);
  assert.equal(h.runtimeTimer.snapshot().allocatedQueries, 0);
  h.pause();
  assert.equal(qaQuery.deleted, false, 'Input pause cannot disrupt the controlled test owner');
  h.qa.render(1 / 60);
  assert.equal(h.qaTimer.status, 'ready');
  assert.deepEqual(h.gpu.violations, []);

  // The benchmark owner disables its timer before yielding runtime ownership.
  h.qaTimer.setEnabled(false);
  h.qa.setTesting(false);
  assert.equal(qaQuery.deleted, true);
  h.resume();
  h.frame(90000);
  assert.equal(h.fps.at(-1).dt, 0);
  assert.equal(h.timings.at(-1).gpuMs, null);
  assert.equal(h.budget.snapshot().frame.sampleCount, 0);
  assert.equal(h.runtimeTimer.status, 'ready');
  assert.equal(h.gpu.active, null);
  assert.deepEqual(h.gpu.violations, []);
});
