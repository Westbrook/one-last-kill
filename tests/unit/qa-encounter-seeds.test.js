import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createEncounterSeedSource } from '../../src/game/encounter-session.js';

const qaSource = readFileSync(new URL('../../src/testing/qa.js', import.meta.url), 'utf8');
const runSuiteSource = qaSource.match(/^  async function runSuite\(\) \{[^]*?^  \}/m)?.[0];
const disposeStart = qaSource.lastIndexOf('\n    dispose() {');
const disposeEnd = qaSource.indexOf('\n    },', disposeStart);
assert.ok(runSuiteSource && disposeStart >= 0 && disposeEnd > disposeStart,
  'Keep the explicit runtime fixture aligned with the actual QA suite and returned dispose method');
const disposeSource = qaSource.slice(disposeStart + 1, disposeEnd + 6);

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function reachMicrotask(predicate, message) {
  for (let turn = 0; turn < 12 && !predicate(); turn++) await Promise.resolve();
  assert.ok(predicate(), message);
}

// Execute the production lifecycle functions, not a copy of their cleanup
// logic. The real seed source is isolated per fixture. Rendering, audio gates,
// resets and UI operations are explicit call records; no browser application,
// AudioContext, timers or network services are constructed.
function qaHarness({
  priorOverride,
  checks = [['authored fixture', () => 'complete']],
  manualFrames = false,
  failResetAt = -1,
  failSetup = null,
  busy = false,
  disposed = false,
} = {}) {
  const source = createEncounterSeedSource({
    fillRandom(values) { values[0] = 12345; return values; },
  });
  source.setOverride(priorOverride);
  const events = [], resets = [], reports = [], frames = [], checkCalls = [];
  let context, clock = 0, failedSetup = false;
  const record = (kind, values = {}) => events.push({ kind, ...values });
  function setupFault(stage, enabled = true) {
    if (enabled && failSetup === stage && !failedSetup) {
      failedSetup = true;
      throw new Error(`Injected ${stage} setup failure`);
    }
  }
  const seeds = {
    next() {
      const seed = source.next();
      record('next', { seed });
      return seed;
    },
    setOverride(value) {
      const previous = source.setOverride(value);
      record('override', { value });
      return previous;
    },
    snapshot: () => source.snapshot(),
  };
  function freshApartment() {
    const { mode, override } = seeds.snapshot();
    const reset = { mode, override };
    resets.push(reset);
    record('reset', { mode, override });
    if (resets.length === failResetAt) throw new Error('Injected apartment reset failure');
    // A reset constructs an encounter under the policy active at this exact
    // point. Restoring the singleton afterward cannot repair that encounter.
    reset.seed = seeds.next();
    context.inspectedActor = null;
    context.visualFixtureActive = false;
  }
  const harness = { seeds, events, resets, reports, frames, checkCalls, freshApartment };
  const ui = {
    select: { value: 'street' },
    dispose() { record('ui.dispose'); context.uiDisposed = true; },
  };
  context = {
    busy, disposed, abortSuite: null, abortBenchmark: null,
    inspectedActor: null, visualFixtureActive: false, restoreFixtureTriggers: null,
    testing: false, inspection: false, uiDisposed: false,
    EncounterSeeds: seeds, ui, freshApartment,
    tests: checks.map(([name, run]) => [name, () => {
      checkCalls.push(name);
      return run(harness);
    }]),
    performance: { now: () => ++clock },
    setBusy(value) {
      context.busy = value; record('busy', { value });
      setupFault('busy', value);
    },
    api: {
      setTesting(value) {
        context.testing = value; record('testing', { value });
        setupFault('testing', value);
      },
      setInspection(value) { context.inspection = value; record('inspection', { value }); },
    },
    pauseSilently() { record('pause'); setupFault('pause'); },
    assertSilent() { record('assertSilent'); },
    pausedRender() { record('render'); },
    setNPCInspection(value) { record('specimen', { value }); },
    report(state, lines) {
      const text = Array.isArray(lines) ? Array.from(lines).join('\n') : String(lines);
      reports.push({ state, text }); record('report', { state });
      setupFault('report', state === 'running');
    },
    requestAnimationFrame(callback) {
      if (manualFrames) frames.push(callback);
      else callback(++clock);
      return frames.length;
    },
    renderer: { domElement: {
      removeEventListener(name) { record('removeCanvasListener', { name }); },
    } },
    document: {
      removeEventListener(name) { record('removeDocumentListener', { name }); },
    },
    removeEventListener(name) { record('removeWindowListener', { name }); },
    configureRenderer() { record('configureRenderer'); },
    blockSpecimenClick() {},
    guardSpecimenSession() {},
    restoreGameplayScale() {},
    retainReviewScale() {},
  };
  const lifecycle = runInNewContext(`${runSuiteSource}\n;({ runSuite, ${disposeSource} });`, context,
    { filename: 'src/testing/qa.js (suite lifecycle)' });
  return Object.assign(harness, lifecycle, {
    state: context,
    releaseFrame() {
      assert.ok(frames.length > 0, 'A real suite frame must be pending before it can be released');
      frames.shift()(++clock);
    },
  });
}

function assertReleased(harness, override) {
  assert.equal(harness.seeds.snapshot().override, override, 'Restore the raw prior override, including undefined or zero');
  assert.equal(harness.state.busy, false);
  assert.equal(harness.state.testing, false);
  assert.equal(harness.state.abortSuite, null, 'A completed scope cannot retain a stale cleanup callback');
}

for (const [label, priorOverride] of [
  ['random', undefined], ['authored', null], ['zero', 0], ['fixed', 42], ['maximum uint32', 0xffffffff],
]) {
  test(`the actual QA suite restores ${label} mode before its final apartment reset`, async () => {
    const authored = harness => {
      assert.equal(harness.seeds.snapshot().mode, 'authored');
      assert.equal(harness.seeds.next(), null);
      return 'authored encounter observed';
    };
    const h = qaHarness({ priorOverride, checks: [['first', authored], ['second', authored]] });
    assert.equal(h.seeds.snapshot().override, priorOverride, 'Creating the lifecycle fixture cannot pin a seed');
    assert.equal(h.events.length, 0);
    await h.runSuite();
    assertReleased(h, priorOverride);
    assert.equal(h.resets.length, 3, 'Each check gets a reset, followed by one final reset');
    assert.deepEqual(h.resets.slice(0, 2).map(reset => reset.override), [null, null]);
    const final = h.resets.at(-1);
    assert.equal(final.override, priorOverride, 'The encounter left for play is created after restoring the override');
    assert.deepEqual(h.events.filter(event => event.kind === 'override').map(event => event.value), [null, priorOverride]);
    assert.ok(h.events.findLastIndex(event => event.kind === 'override')
      < h.events.findLastIndex(event => event.kind === 'reset'), 'Restore must precede the final reset call');
    assert.equal(h.reports.at(-1).state, 'pass');
    assert.match(h.reports.at(-1).text, /2\/2 checks/);
    assert.equal(h.state.ui.select.value, 'apartment');
    if (priorOverride === undefined) {
      assert.equal(final.mode, 'random');
      assert.ok(Number.isInteger(final.seed));
      assert.equal(h.seeds.snapshot().attempts, 1, 'Authored checks consume no random attempts');
      h.freshApartment();
      assert.notEqual(h.resets.at(-1).seed, final.seed, 'The next ordinary reset remains a fresh random attempt');
    } else {
      assert.equal(final.seed, priorOverride);
      assert.equal(h.seeds.snapshot().attempts, 0);
    }
  });
}

test('a failed nested fixed-seed fixture restores authored mode for the next check and random mode afterward', async () => {
  const h = qaHarness({ checks: [
    ['nested seed', harness => {
      const previous = harness.seeds.setOverride(0);
      try {
        assert.equal(previous, null);
        harness.freshApartment();
        assert.equal(harness.resets.at(-1).seed, 0);
        throw new Error('Seeded fixture failed');
      } finally { harness.seeds.setOverride(previous); }
    }],
    ['following authored check', harness => {
      assert.equal(harness.seeds.snapshot().override, null);
      return 'authored mode retained';
    }],
  ] });
  await h.runSuite();
  assertReleased(h, undefined);
  assert.deepEqual(h.resets.map(reset => reset.override), [null, 0, null, undefined]);
  assert.deepEqual(h.events.filter(event => event.kind === 'override').map(event => event.value), [null, 0, null, undefined]);
  assert.equal(h.reports.at(-1).state, 'fail');
  assert.match(h.reports.at(-1).text, /Seeded fixture failed/);
  assert.match(h.reports.at(-1).text, /PASS · following authored check/);
});

test('a failed per-check apartment reset does not leak authored mode or skip subsequent checks', async () => {
  const h = qaHarness({ priorOverride: 42, failResetAt: 1,
    checks: [['blocked setup', () => assert.fail('A failed reset cannot run its check')], ['next check', () => 'complete']] });
  await h.runSuite();
  assertReleased(h, 42);
  assert.deepEqual(h.checkCalls, ['next check']);
  assert.equal(h.resets.at(-1).seed, 42);
  assert.equal(h.reports.at(-1).state, 'fail');
  assert.match(h.reports.at(-1).text, /Injected apartment reset failure/);
});

for (const failSetup of ['busy', 'testing', 'pause', 'report']) {
  test(`a ${failSetup} setup exception still restores the seed policy and releases the suite`, async () => {
    const h = qaHarness({ priorOverride: 0, failSetup });
    await assert.rejects(h.runSuite(), new RegExp(`Injected ${failSetup} setup failure`));
    assertReleased(h, 0);
    assert.equal(h.checkCalls.length, 0);
    assert.equal(h.resets.length, 1);
    assert.equal(h.resets[0].override, 0);
    assert.equal(h.resets[0].seed, 0);
    const finalReport = h.reports.at(-1);
    assert.equal(finalReport.state, 'fail', 'A setup exception cannot leave a visible pass status');
    assert.match(finalReport.text, /^FAILED · 0\/1 checks/);
    assert.match(finalReport.text, /FAIL · Suite interrupted/);
    assert.match(finalReport.text, new RegExp(`Injected ${failSetup} setup failure`));
  });
}

test('a failed final reset cannot prevent override restoration or leave the suite busy', async () => {
  const h = qaHarness({ failResetAt: 2 });
  await h.runSuite();
  assertReleased(h, undefined);
  assert.equal(h.resets.length, 2);
  assert.equal(h.resets[1].override, undefined, 'The original policy was restored even before the reset threw');
  assert.equal(h.reports.at(-1).state, 'fail');
  assert.match(h.reports.at(-1).text, /FAIL · Final reset/);
});

test('disposal restores seeds synchronously while a suite frame is suspended, and late delivery does nothing', async () => {
  const h = qaHarness({ manualFrames: true, checks: [['first', () => 'complete'], ['must not run', () => assert.fail()]] });
  const running = h.runSuite();
  await reachMicrotask(() => h.frames.length === 1, 'The suite must actually reach its pending animation frame');
  const activeCleanup = h.state.abortSuite, beforeRejectedRun = h.events.slice();
  await h.runSuite();
  assert.deepEqual(h.events, beforeRejectedRun, 'A rejected duplicate cannot acquire or restore a seed scope');
  assert.equal(h.state.abortSuite, activeCleanup);
  h.dispose();
  assertReleased(h, undefined);
  assert.equal(h.resets.length, 2);
  assert.equal(h.resets.at(-1).mode, 'random');
  assert.equal(h.state.uiDisposed, true);
  assert.equal(h.state.inspection, false);
  h.seeds.setOverride(91);
  const afterDisposal = h.events.slice();
  h.releaseFrame();
  await running;
  assert.deepEqual(h.events, afterDisposal, 'A late frame cannot reset, report, change play gates or restore an obsolete override');
  assert.equal(h.seeds.snapshot().override, 91);
  assert.deepEqual(h.checkCalls, ['first']);
});

for (const outcome of ['resolve', 'reject']) {
  test(`a check that ${outcome}s after disposal cannot rerun cleanup or overwrite the restored session`, async () => {
    const pending = deferred();
    const h = qaHarness({ priorOverride: 0,
      checks: [['pending check', () => pending.promise], ['must not run', () => assert.fail()]] });
    const running = h.runSuite();
    assert.deepEqual(h.checkCalls, ['pending check']);
    h.dispose();
    assertReleased(h, 0);
    assert.equal(h.resets.length, 2);
    assert.equal(h.resets.at(-1).seed, 0);
    h.seeds.setOverride(undefined);
    const afterDisposal = h.events.slice();
    if (outcome === 'resolve') pending.resolve('late result');
    else pending.reject(new Error('Late check failure'));
    await running;
    assert.deepEqual(h.events, afterDisposal);
    assert.equal(h.seeds.snapshot().mode, 'random');
    assert.deepEqual(h.checkCalls, ['pending check']);
  });
}

for (const guard of ['busy', 'disposed']) {
  test(`an already ${guard} QA panel cannot start a seed scope`, async () => {
    const h = qaHarness({ priorOverride: 0, [guard]: true });
    await h.runSuite();
    assert.equal(h.seeds.snapshot().override, 0);
    assert.equal(h.events.length, 0);
    assert.equal(h.resets.length, 0);
    assert.equal(h.state.abortSuite, null);
  });
}

test('disposing an idle panel is seed-neutral', () => {
  const h = qaHarness({ priorOverride: 42 });
  h.dispose();
  assert.equal(h.seeds.snapshot().override, 42);
  assert.equal(h.seeds.snapshot().attempts, 0);
  assert.equal(h.events.filter(event => event.kind === 'override').length, 0);
  assert.equal(h.resets.length, 0);
});

test('a later suite invocation owns a new scope and restores its own prior override', async () => {
  const h = qaHarness();
  await h.runSuite();
  assertReleased(h, undefined);
  h.seeds.setOverride(0);
  await h.runSuite();
  assertReleased(h, 0);
  assert.deepEqual(h.resets.map(reset => reset.override), [null, undefined, null, 0]);
  assert.equal(h.resets.at(-1).seed, 0);
});
