import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpuFrameTimer } from '../../src/core/gpu-frame-timer.js';

function createContext({ supported = true, events = true, counterBits = 64 } = {}) {
  const extension = { TIME_ELAPSED_EXT: 35007, GPU_DISJOINT_EXT: 36795, QUERY_COUNTER_BITS_EXT: 34916 };
  const calls = [], queries = [], listeners = new Map();
  let active = null, lost = false, disjoint = false;
  const gl = {
    QUERY_RESULT_AVAILABLE: 34919,
    QUERY_RESULT: 34918,
    canvas: events ? {
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name, callback) {
        assert.equal(listeners.get(name), callback);
        listeners.delete(name);
      },
    } : undefined,
    getExtension(name) {
      calls.push(['extension', name]);
      assert.equal(name, 'EXT_disjoint_timer_query_webgl2');
      return supported ? extension : null;
    },
    isContextLost() { calls.push(['isContextLost']); return lost; },
    getQuery(target, parameter) {
      assert.equal(this, gl, 'WebGL methods retain their native context receiver');
      assert.equal(lost, false);
      assert.equal(target, extension.TIME_ELAPSED_EXT);
      assert.equal(parameter, extension.QUERY_COUNTER_BITS_EXT);
      calls.push(['counter-bits']);
      return counterBits;
    },
    createQuery() {
      assert.equal(lost, false);
      const query = { id: queries.length, available: false, nanoseconds: 0, deleted: false };
      queries.push(query);
      calls.push(['create', query.id]);
      return query;
    },
    beginQuery(target, query) {
      assert.equal(lost, false);
      assert.equal(target, extension.TIME_ELAPSED_EXT);
      assert.equal(active, null, 'Only one elapsed query may be active');
      assert.equal(query.deleted, false);
      query.available = false;
      active = query;
      calls.push(['begin', query.id]);
    },
    endQuery(target) {
      assert.equal(lost, false);
      assert.equal(target, extension.TIME_ELAPSED_EXT);
      assert.notEqual(active, null, 'Only an active query may be ended');
      calls.push(['end', active.id]);
      active = null;
    },
    getParameter(parameter) {
      assert.equal(lost, false);
      assert.equal(parameter, extension.GPU_DISJOINT_EXT);
      calls.push(['disjoint']);
      return disjoint;
    },
    getQueryParameter(query, parameter) {
      assert.equal(lost, false);
      assert.equal(query.deleted, false);
      assert.notEqual(query, active, 'An active query must not be polled');
      if (parameter === gl.QUERY_RESULT_AVAILABLE) {
        calls.push(['available', query.id]);
        return query.available;
      }
      assert.equal(parameter, gl.QUERY_RESULT);
      assert.equal(query.available, true, 'Reading an unfinished query would stall the GPU');
      calls.push(['result', query.id]);
      return query.nanoseconds;
    },
    deleteQuery(query) {
      assert.equal(lost, false);
      assert.notEqual(query, active);
      assert.equal(query.deleted, false, 'Every query is deleted at most once');
      query.deleted = true;
      calls.push(['delete', query.id]);
    },
    finish() { assert.fail('GPU timing must not wait for the GPU'); },
    flush() { assert.fail('GPU timing must not force a flush'); },
    readPixels() { assert.fail('GPU timing must not read pixels'); },
  };
  return {
    gl, calls, queries, listeners,
    complete(query, milliseconds) { query.nanoseconds = milliseconds * 1e6; query.available = true; },
    setDisjoint(value) { disjoint = value; },
    setCounterBits(value) { counterBits = value; },
    loseContext() { lost = true; active = null; listeners.get('webglcontextlost')?.(); },
    restoreContext() { lost = false; listeners.get('webglcontextrestored')?.(); },
  };
}

function sample(timer, context, milliseconds) {
  assert.equal(timer.begin(), true);
  assert.equal(timer.end(), true);
  const query = context.queries.find(entry => !entry.deleted && !entry.available);
  context.complete(query, milliseconds);
  return timer.snapshot();
}

test('GPU timing is disabled by default and makes no GL calls or event subscriptions', () => {
  const context = createContext(), timer = createGpuFrameTimer(context.gl);
  for (let frame = 0; frame < 100; frame++) {
    assert.equal(timer.begin(), false);
    assert.equal(timer.end(), false);
  }
  assert.equal(timer.snapshot().status, 'disabled');
  assert.equal(timer.snapshot().supported, null, 'Disabled timers have not probed support');
  assert.equal(timer.snapshot().counterBits, null);
  timer.reset();
  timer.dispose();
  assert.deepEqual(context.calls, []);
  assert.equal(context.listeners.size, 0);
});

test('missing WebGL 2 timer extension reports unsupported without fabricating GPU timings', () => {
  const context = createContext({ supported: false });
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  const initializedCalls = context.calls.length;
  for (let frame = 0; frame < 10; frame++) { timer.begin(); timer.end(); }
  const snapshot = timer.snapshot();
  assert.equal(snapshot.status, 'unsupported');
  assert.equal(snapshot.supported, false);
  assert.equal(snapshot.latestMs, null);
  assert.equal(snapshot.medianMs, null);
  assert.equal(snapshot.p95Ms, null);
  assert.equal(snapshot.sampleCount, 0);
  assert.equal(context.calls.length, initializedCalls, 'Do not probe unsupported contexts on every frame');
  assert.equal(context.queries.length, 0);
  assert.equal(context.calls.some(([kind]) => kind === 'counter-bits'), false);
  assert.equal(createGpuFrameTimer(null, { enabled: true }).snapshot().status, 'unsupported');
});

test('elapsed-counter capability uses the native query-target API once and permits a valid zero-duration sample', () => {
  const context = createContext({ counterBits: 30 });
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  assert.equal(timer.snapshot().status, 'ready');
  assert.equal(timer.snapshot().supported, true);
  assert.equal(timer.snapshot().counterBits, 30);
  const snapshot = sample(timer, context, 0);
  assert.equal(snapshot.sampleCount, 1);
  assert.equal(snapshot.latestMs, 0, 'A usable counter may report zero for work below its timer granularity');
  assert.equal(context.calls.filter(([kind]) => kind === 'counter-bits').length, 1,
    'Capability probing does not add a query on each sampled frame');
});

test('zero-bit and invalid elapsed counters report unsupported without allocating queries or fabricated durations', () => {
  for (const bits of [0, -1, NaN, Infinity, null, '64', 64.5]) {
    const context = createContext({ counterBits: bits });
    const timer = createGpuFrameTimer(context.gl, { enabled: true });
    const initializedCalls = context.calls.length;
    for (let frame = 0; frame < 10; frame++) { assert.equal(timer.begin(), false); assert.equal(timer.end(), false); }
    const snapshot = timer.snapshot();
    assert.equal(snapshot.supported, false);
    assert.equal(snapshot.status, 'unsupported');
    assert.equal(snapshot.counterBits, bits === 0 ? 0 : null);
    assert.equal(snapshot.sampleCount, 0);
    assert.equal(snapshot.latestMs, null);
    assert.equal(snapshot.medianMs, null);
    assert.equal(snapshot.p95Ms, null);
    assert.equal(context.queries.length, 0);
    assert.equal(context.calls.length, initializedCalls, 'Unsupported counters are not polled every frame');
    timer.dispose();
    assert.equal(context.listeners.size, 0);
  }
});

test('a context fake without the WebGL 2 query-target API degrades gracefully to unsupported', () => {
  const context = createContext();
  delete context.gl.getQuery;
  let timer;
  assert.doesNotThrow(() => { timer = createGpuFrameTimer(context.gl, { enabled: true }); });
  assert.equal(timer.snapshot().status, 'unsupported');
  assert.equal(timer.snapshot().supported, false);
  assert.equal(timer.snapshot().counterBits, null);
  assert.equal(timer.begin(), false);
  assert.equal(context.queries.length, 0);
});

test('a failing counter capability query cannot interrupt rendering or claim supported timing', () => {
  const context = createContext();
  let probes = 0;
  context.gl.getQuery = () => { probes++; throw new Error('Counter capability denied'); };
  let timer;
  assert.doesNotThrow(() => { timer = createGpuFrameTimer(context.gl, { enabled: true }); });
  const snapshot = timer.snapshot();
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.supported, false);
  assert.equal(snapshot.counterBits, null);
  assert.equal(snapshot.sampleCount, 0);
  assert.equal(snapshot.latestMs, null);
  for (let frame = 0; frame < 10; frame++) { assert.equal(timer.begin(), false); assert.equal(timer.end(), false); }
  assert.equal(context.queries.length, 0);
  assert.equal(probes, 1);
  timer.dispose();
  assert.equal(context.listeners.size, 0);
});

test('context restoration rechecks counter capability instead of retaining old support or samples', () => {
  const context = createContext({ counterBits: 0 });
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  assert.equal(timer.snapshot().status, 'unsupported');
  context.loseContext();
  assert.equal(timer.snapshot().counterBits, null);
  context.setCounterBits(64);
  context.restoreContext();
  assert.equal(timer.snapshot().counterBits, 64);
  assert.equal(sample(timer, context, 4).medianMs, 4);
  context.loseContext();
  context.setCounterBits(0);
  context.restoreContext();
  const snapshot = timer.snapshot();
  assert.equal(snapshot.supported, false);
  assert.equal(snapshot.status, 'unsupported');
  assert.equal(snapshot.counterBits, 0);
  assert.equal(snapshot.sampleCount, 0);
  assert.equal(snapshot.latestMs, null);
  assert.equal(timer.begin(), false);
  assert.equal(context.calls.filter(([kind]) => kind === 'counter-bits').length, 3);
});

test('unfinished GPU queries are never read and saturation skips frames with a bounded pool', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true, maxQueries: 2 });
  for (let frame = 0; frame < 2; frame++) { assert.equal(timer.begin(), true); timer.end(); }
  for (let frame = 0; frame < 20; frame++) { assert.equal(timer.begin(), false); assert.equal(timer.end(), false); }
  const snapshot = timer.snapshot();
  assert.equal(snapshot.pendingQueries, 2);
  assert.equal(snapshot.allocatedQueries, 2);
  assert.equal(snapshot.skippedFrames, 20);
  assert.equal(snapshot.sampleCount, 0);
  assert.equal(context.queries.length, 2);
  assert.equal(context.calls.some(([kind]) => kind === 'result'), false);
  context.complete(context.queries[0], 6.25);
  assert.equal(timer.begin(), true, 'A completed query immediately becomes reusable');
  timer.end();
  assert.equal(timer.snapshot().latestMs, 6.25);
  assert.equal(context.queries.length, 2, 'Query reuse never expands the pool');
});

test('completed query durations are converted from nanoseconds and measured in submission order', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  timer.begin(); timer.end();
  timer.begin(); timer.end();
  context.complete(context.queries[1], 4.5);
  assert.equal(timer.snapshot().sampleCount, 0, 'Do not reorder samples around unfinished work');
  context.complete(context.queries[0], 1.25);
  const snapshot = timer.snapshot();
  assert.equal(snapshot.totalSamples, 2);
  assert.equal(snapshot.latestMs, 4.5);
  assert.equal(snapshot.medianMs, 2.875);
  assert.equal(snapshot.p95Ms, 4.5);
  assert.equal(snapshot.pendingQueries, 0);
  assert.deepEqual(context.calls.filter(([kind]) => kind === 'result').map(([, id]) => id), [0, 1]);
});

test('rolling statistics retain only the configured window and use nearest-rank p95', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true, sampleWindow: 20 });
  sample(timer, context, 1000);
  sample(timer, context, 2000);
  for (let milliseconds = 1; milliseconds <= 20; milliseconds++) sample(timer, context, milliseconds);
  const snapshot = timer.snapshot();
  assert.equal(snapshot.sampleCount, 20);
  assert.equal(snapshot.totalSamples, 22);
  assert.equal(snapshot.latestMs, 20);
  assert.equal(snapshot.medianMs, 10.5);
  assert.equal(snapshot.p95Ms, 19);
  assert.equal(context.queries.length, 1, 'Available queries are pooled across the entire run');
});

test('disjoint intervals discard every pending query while retaining previously valid samples', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  sample(timer, context, 5);
  timer.begin(); timer.end();
  timer.begin(); timer.end();
  context.complete(context.queries[0], 999);
  context.setDisjoint(true);
  const readsBefore = context.calls.filter(([kind]) => kind === 'result').length;
  const snapshot = timer.snapshot();
  assert.equal(snapshot.sampleCount, 1);
  assert.equal(snapshot.latestMs, 5);
  assert.equal(snapshot.disjointEvents, 1);
  assert.equal(snapshot.discardedQueries, 2);
  assert.equal(snapshot.pendingQueries, 0);
  assert.equal(snapshot.allocatedQueries, 0);
  assert.equal(context.calls.filter(([kind]) => kind === 'result').length, readsBefore);
  assert.ok(context.queries.every(query => query.deleted));
  assert.equal(timer.begin(), false, 'Do not measure while the GPU reports disjoint time');
  context.setDisjoint(false);
  assert.equal(sample(timer, context, 7).medianMs, 6);
});

test('invalid duration results cannot poison rolling statistics and zero is a valid duration', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  sample(timer, context, 3);
  sample(timer, context, NaN);
  sample(timer, context, Infinity);
  sample(timer, context, -1);
  const snapshot = sample(timer, context, 0);
  assert.equal(snapshot.sampleCount, 2);
  assert.equal(snapshot.totalSamples, 2);
  assert.equal(snapshot.discardedQueries, 3);
  assert.equal(snapshot.latestMs, 0);
  assert.equal(snapshot.medianMs, 1.5);
  assert.equal(snapshot.p95Ms, 3);
});

test('a benchmark reset drops completed history and outstanding queries before new samples', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  sample(timer, context, 500);
  timer.begin(); timer.end();
  timer.begin();
  const previousQueries = context.queries.slice();
  timer.reset();
  const snapshot = timer.snapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.sampleCount, 0);
  assert.equal(snapshot.totalSamples, 0);
  assert.equal(snapshot.latestMs, null);
  assert.equal(snapshot.pendingQueries, 0);
  assert.equal(snapshot.activeQuery, false);
  assert.equal(snapshot.allocatedQueries, 0);
  assert.ok(previousQueries.every(query => query.deleted));
  for (const query of previousQueries) context.complete(query, 1000);
  const fresh = sample(timer, context, 8);
  assert.equal(fresh.sampleCount, 1);
  assert.equal(fresh.totalSamples, 1);
  assert.equal(fresh.medianMs, 8, 'Results from the old benchmark never reach the new one');
});

test('nested begin and unmatched end do not corrupt the active query or poll it early', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  assert.equal(timer.end(), false);
  assert.equal(timer.begin(), true);
  assert.equal(timer.begin(), false);
  assert.equal(timer.snapshot().activeQuery, true);
  assert.equal(timer.snapshot().pendingQueries, 0);
  assert.equal(timer.end(), true);
  assert.equal(timer.end(), false);
  assert.equal(context.calls.filter(([kind]) => kind === 'begin').length, 1);
  assert.equal(context.calls.filter(([kind]) => kind === 'end').length, 1);
});

test('disabling releases active and pending GPU resources but preserves the completed report', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  sample(timer, context, 9);
  timer.begin(); timer.end();
  timer.begin();
  timer.setEnabled(false);
  assert.ok(context.queries.every(query => query.deleted));
  assert.equal(context.listeners.size, 0);
  const disabledCalls = context.calls.length;
  timer.begin(); timer.end();
  const snapshot = timer.snapshot();
  assert.equal(snapshot.status, 'disabled');
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.latestMs, 9);
  assert.equal(snapshot.sampleCount, 1);
  assert.equal(snapshot.pendingQueries, 0);
  assert.equal(snapshot.activeQuery, false);
  assert.equal(context.calls.length, disabledCalls);
  assert.equal(timer.setEnabled(true), true);
  timer.reset();
  assert.equal(sample(timer, context, 2).medianMs, 2);
});

test('context loss forgets invalid resources and restoration acquires a fresh extension', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  sample(timer, context, 10);
  timer.begin(); timer.end();
  timer.begin();
  context.loseContext();
  const lostCalls = context.calls.length;
  assert.equal(timer.end(), false);
  assert.equal(timer.begin(), false);
  const lost = timer.snapshot();
  assert.equal(lost.status, 'context-lost');
  assert.equal(lost.sampleCount, 0);
  assert.equal(lost.allocatedQueries, 0);
  assert.equal(context.calls.length, lostCalls, 'Lost resources are not ended, read, or deleted');
  const oldQueries = context.queries.slice();
  context.restoreContext();
  assert.equal(timer.snapshot().status, 'ready');
  const beforeFresh = context.queries.length;
  assert.equal(timer.begin(), true);
  assert.equal(context.queries.length, beforeFresh + 1);
  timer.end();
  context.complete(context.queries.at(-1), 4);
  assert.equal(timer.snapshot().medianMs, 4);
  assert.equal(context.calls.filter(([kind]) => kind === 'extension').length, 2);
  assert.ok(oldQueries.every(query => !query.deleted), 'Invalid query objects need no GL cleanup');
});

test('polling detects context loss even without canvas events', () => {
  const context = createContext({ events: false });
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  timer.begin(); timer.end();
  context.loseContext();
  assert.equal(timer.snapshot().status, 'context-lost');
  assert.equal(timer.begin(), false);
  timer.dispose();
  assert.equal(timer.snapshot().status, 'disposed');
});

test('disposal is idempotent, closes active queries, removes listeners and never reactivates', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  timer.begin(); timer.end();
  timer.begin();
  timer.dispose();
  assert.ok(context.queries.every(query => query.deleted));
  assert.equal(context.listeners.size, 0);
  const disposedCalls = context.calls.length;
  timer.dispose(); timer.reset();
  assert.equal(timer.setEnabled(true), false);
  assert.equal(timer.begin(), false);
  assert.equal(timer.end(), false);
  assert.equal(timer.snapshot().status, 'disposed');
  assert.equal(context.calls.length, disposedCalls);
});

test('timer driver failures fail closed without breaking the render loop', () => {
  const context = createContext();
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  timer.begin(); timer.end();
  context.gl.getQueryParameter = () => { throw new Error('Timer unavailable'); };
  assert.doesNotThrow(() => timer.snapshot());
  assert.equal(timer.snapshot().status, 'error');
  assert.equal(timer.snapshot().sampleCount, 0);
  assert.ok(context.queries.every(query => query.deleted));
  assert.equal(timer.begin(), false);
  assert.equal(timer.end(), false);
});

test('query allocation failure degrades to unavailable telemetry instead of throwing', () => {
  const context = createContext();
  context.gl.createQuery = () => null;
  const timer = createGpuFrameTimer(context.gl, { enabled: true });
  assert.equal(timer.begin(), false);
  assert.equal(timer.snapshot().status, 'error');
  assert.equal(timer.snapshot().allocatedQueries, 0);
  assert.equal(timer.snapshot().latestMs, null);
});
