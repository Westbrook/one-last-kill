import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAudioEvent } from '../../src/core/audio-model.js';
import { STREET_ATMOSPHERE, createStreetAtmosphereScheduler } from '../../src/core/street-atmosphere.js';
import { DISTRICT } from '../../src/world/district-layout.js';

function run(scheduler, seconds, hz = 60, options = { zone: 'street' }) {
  const cues = [];
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    const events = scheduler.advance(1 / hz, options);
    assert.ok(events.length <= 1, 'a frame cannot emit a backlog');
    for (const cue of events) cues.push({ cue, at: scheduler.snapshot().elapsed });
  }
  return cues;
}

function near(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be close to ${expected}`);
}

function assertNoOverlap(events) {
  for (let i = 0; i < events.length; i++) {
    const current = events[i];
    const next = events[i + 1];
    if (!next) continue;
    assert.ok(next.at + 1e-7 >= current.at + current.cue.duration,
      `${current.cue.kind} at ${current.at} overlaps ${next.cue.kind} at ${next.at}`);
  }
}

test('street profiles are restrained, deeply frozen, and work with positional attenuation', () => {
  assert.equal(Object.isFrozen(STREET_ATMOSPHERE), true);
  const alarmCar = DISTRICT.street.parkedCars.find(car => car.id === 'far');
  assert.deepEqual(STREET_ATMOSPHERE['car-alarm'].pos, { x: alarmCar.x, y: alarmCar.y + 0.85, z: alarmCar.z });
  assert.deepEqual(STREET_ATMOSPHERE['distant-siren'].pos, { x: -48, y: 3, z: 17 });
  for (const [kind, cue] of Object.entries(STREET_ATMOSPHERE)) {
    assert.equal(cue.kind, kind);
    assert.equal(Object.isFrozen(cue), true);
    assert.equal(Object.isFrozen(cue.pos), true);
    assert.equal(Object.isFrozen(cue.frequencyAutomation), true);
    assert.ok(['triangle', 'sine'].includes(cue.waveform));
    assert.ok(cue.gain > 0 && cue.gain <= 0.16);
    assert.ok(cue.attack > 0 && cue.attack < cue.duration);
    let previousTime = 0;
    for (const step of cue.frequencyAutomation) {
      assert.equal(Object.isFrozen(step), true);
      assert.ok(step.time > previousTime && step.time <= cue.duration);
      assert.ok(step.frequency > 100 && step.frequency <= cue.cutoff);
      previousTime = step.time;
    }
    const nearSource = describeAudioEvent(cue, { pos: cue.pos });
    const atBakery = describeAudioEvent({ ...cue, environment: 'bakery' }, { pos: { x: 0, y: 1.7, z: 0 } });
    assert.equal(nearSource.gain, 1);
    assert.ok(atBakery.gain > 0 && atBakery.gain < nearSource.gain);
    assert.equal(atBakery.interior, true);
  }
});

test('the district starts quietly, then has three short alarms and one distant siren', () => {
  const scheduler = createStreetAtmosphereScheduler();
  assert.deepEqual(run(scheduler, 2.75), []);
  const events = run(scheduler, 9.25);
  assert.deepEqual(events.map(({ cue }) => cue.kind), ['car-alarm', 'car-alarm', 'car-alarm', 'distant-siren']);
  events.forEach(({ at }, index) => near(at, [3, 3.5, 4, 11][index]));
  assert.equal(scheduler.snapshot().alarmCount, 3);
  assert.equal(scheduler.snapshot().alarmClusterCount, 1);
  assert.equal(scheduler.snapshot().sirenCount, 1);
  assertNoOverlap(events);
});

test('several minutes retain long quiet gaps and bounded cadence', () => {
  const scheduler = createStreetAtmosphereScheduler();
  const events = run(scheduler, 240);
  assertNoOverlap(events);
  const alarms = events.filter(({ cue }) => cue.kind === 'car-alarm');
  const sirens = events.filter(({ cue }) => cue.kind === 'distant-siren');
  assert.ok(alarms.length >= 24 && alarms.length <= 36);
  assert.ok(sirens.length >= 5 && sirens.length <= 7);
  for (let i = 1; i < alarms.length; i++) {
    const gap = alarms[i].at - alarms[i - 1].at;
    if (i % 3) near(gap, 0.5);
    else assert.ok(gap - 0.3 >= 18 - 1e-7, 'clusters keep their full quiet gap');
  }
  for (let i = 1; i < sirens.length; i++) {
    assert.ok(sirens[i].at - sirens[i - 1].at - 5 >= 30, 'sirens leave a long quiet gap');
  }
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.alarmCount, alarms.length);
  assert.equal(snapshot.sirenCount, sirens.length);
});

test('cue order stays identical across frame subdivisions over several cycles', () => {
  const expected = run(createStreetAtmosphereScheduler(), 180, 120).map(({ cue }) => cue);
  for (const hz of [4, 30, 60]) {
    assert.deepEqual(run(createStreetAtmosphereScheduler(), 180, hz).map(({ cue }) => cue), expected);
  }
  for (const busy of [{ radioActive: true }, { threat: 0.9 }]) {
    const baseline = createStreetAtmosphereScheduler();
    run(baseline, 16, 120, { zone: 'street', ...busy });
    const afterBusy = run(baseline, 20, 120).map(({ cue }) => cue);
    for (const hz of [4, 30, 60]) {
      const scheduler = createStreetAtmosphereScheduler();
      run(scheduler, 16, hz, { zone: 'street', ...busy });
      assert.deepEqual(run(scheduler, 20, hz).map(({ cue }) => cue), afterBusy);
    }
  }
});

test('radio and heavy threat defer due cues without accumulating missed pulses', () => {
  for (const busy of [{ threat: 0.600001 }, { radioActive: true }]) {
    const scheduler = createStreetAtmosphereScheduler();
    assert.deepEqual(run(scheduler, 80, 60, { zone: 'street', ...busy }), []);
    const waiting = scheduler.snapshot();
    assert.equal(waiting.alarmCount, 0);
    assert.equal(waiting.sirenCount, 0);
    assert.ok(waiting.nextAlarmAt > waiting.elapsed);
    assert.ok(waiting.nextAlarmAt <= waiting.elapsed + 1.25);
    assert.ok(waiting.nextSirenAt > waiting.elapsed);
    assert.ok(waiting.nextSirenAt <= waiting.elapsed + 1.25);
    const events = run(scheduler, 20);
    assert.ok(events.length >= 4 && events.length <= 5);
    assertNoOverlap(events);
    const alarms = events.filter(({ cue }) => cue.kind === 'car-alarm');
    assert.equal(alarms.length, 3);
    near(alarms[1].at - alarms[0].at, 0.5);
    near(alarms[2].at - alarms[1].at, 0.5);
  }
  const threshold = createStreetAtmosphereScheduler();
  assert.equal(run(threshold, 3, 60, { zone: 'street', threat: 0.6 }).length, 1);
});

test('a delayed alarm reserves its entire cluster across the original siren deadline', () => {
  const scheduler = createStreetAtmosphereScheduler();
  assert.deepEqual(run(scheduler, 10, 60, { zone: 'street', radioActive: true }), []);
  const events = run(scheduler, 9);
  assert.deepEqual(events.map(({ cue }) => cue.kind), ['car-alarm', 'car-alarm', 'car-alarm', 'distant-siren']);
  assert.ok(events[0].at > 10);
  assert.ok(events[3].at >= events[2].at + events[2].cue.duration);
  assertNoOverlap(events);
});

test('an interrupted cluster is discarded and resumes as one correctly spaced cluster', () => {
  const scheduler = createStreetAtmosphereScheduler();
  const first = run(scheduler, 3);
  assert.equal(first.length, 1);
  assert.deepEqual(run(scheduler, 6, 60, { zone: 'street', radioActive: true }), []);
  assert.equal(scheduler.snapshot().alarmPulsesRemaining, 0);
  const resumed = run(scheduler, 10);
  const alarms = resumed.filter(({ cue }) => cue.kind === 'car-alarm');
  assert.equal(alarms.length, 3);
  near(alarms[1].at - alarms[0].at, 0.5);
  near(alarms[2].at - alarms[1].at, 0.5);
  assert.equal(scheduler.snapshot().alarmClusterCount, 2);
  assertNoOverlap([...first, ...resumed]);
});

test('street and bakery share a cycle, including an alarm already in progress', () => {
  const scheduler = createStreetAtmosphereScheduler();
  const expected = createStreetAtmosphereScheduler();
  run(scheduler, 3);
  run(expected, 3);
  const fromBakery = run(scheduler, 1, 60, { zone: 'bakery' });
  assert.deepEqual(fromBakery, run(expected, 1));
  assert.equal(scheduler.snapshot().zone, 'bakery');
  assert.deepEqual(run(scheduler, 15), run(expected, 15));
  assert.deepEqual(scheduler.snapshot(), expected.snapshot());
});

test('leaving the district resets pending cues and re-entry waits the first delay', () => {
  for (const outsideZone of ['scaffolding', 'roof', 'church', '', undefined]) {
    const scheduler = createStreetAtmosphereScheduler();
    run(scheduler, 3);
    assert.deepEqual(scheduler.advance(0.1, { zone: outsideZone }), []);
    const outside = scheduler.snapshot();
    assert.equal(outside.elapsed, 0);
    assert.equal(outside.alarmPulsesRemaining, 0);
    assert.equal(outside.alarmCount, 0);
    assert.equal(outside.busyKind, null);
    assert.deepEqual(run(scheduler, 2.75, 60, { zone: 'bakery' }), []);
    const events = run(scheduler, 0.25, 60, { zone: 'bakery' });
    assert.equal(events.length, 1);
    assert.equal(events[0].cue.kind, 'car-alarm');
    near(events[0].at, 3);
  }
});

test('disabled, paused, and invalid time calls preserve all state and do not queue cues', () => {
  const scheduler = createStreetAtmosphereScheduler();
  const expected = createStreetAtmosphereScheduler();
  run(scheduler, 3);
  run(expected, 3);
  const before = scheduler.snapshot();
  const empty = scheduler.advance(50, { zone: 'roof', enabled: false });
  assert.equal(Object.isFrozen(empty), true);
  for (const enabled of [false, 0, null, 'true']) {
    assert.equal(scheduler.advance(20, { zone: 'bakery', threat: 1, radioActive: true, enabled }), empty);
    assert.deepEqual(scheduler.snapshot(), before);
  }
  for (const dt of [0, -1, NaN, Infinity, -Infinity, null, undefined, '1', {}, 1n, Symbol('time')]) {
    assert.equal(scheduler.advance(dt, { zone: 'roof', threat: 1 }), empty);
    assert.deepEqual(scheduler.snapshot(), before);
  }
  assert.deepEqual(run(scheduler, 14), run(expected, 14));
  assert.deepEqual(scheduler.snapshot(), expected.snapshot());
});

test('long simulation frames discard excess time and never catch up afterward', () => {
  for (const dt of [1, 60, Number.MAX_VALUE]) {
    const scheduler = createStreetAtmosphereScheduler();
    const expected = createStreetAtmosphereScheduler();
    run(scheduler, 2.75);
    run(expected, 2.75);
    assert.deepEqual(scheduler.advance(dt, { zone: 'street' }), expected.advance(0.25, { zone: 'street' }));
    assert.deepEqual(scheduler.snapshot(), expected.snapshot());
    assert.deepEqual(run(scheduler, 10), run(expected, 10));
  }
});

test('reset is reproducible and malformed options leave bounded safe state', () => {
  const scheduler = createStreetAtmosphereScheduler();
  const initial = scheduler.snapshot();
  const first = run(scheduler, 30);
  scheduler.reset();
  assert.deepEqual(scheduler.snapshot(), initial);
  assert.deepEqual(run(scheduler, 30), first);
  for (const settings of [null, undefined, false, 1, 'street', { zone: {} }]) {
    assert.doesNotThrow(() => scheduler.advance(0.1, settings));
    assert.equal(scheduler.snapshot().elapsed, 0);
  }
  scheduler.advance(0.1, { zone: 'z'.repeat(10000) });
  assert.equal(scheduler.snapshot().zone.length, 96);
  for (const [threat, expected] of [[-1, 0], [2, 1], [NaN, 0], [Infinity, 0], ['1', 0]]) {
    scheduler.advance(0.1, { zone: 'street', threat });
    assert.equal(scheduler.snapshot().threat, expected);
  }
  const before = scheduler.snapshot();
  scheduler.snapshot().elapsed = 500;
  scheduler.snapshot().zone = 'changed';
  assert.deepEqual(scheduler.snapshot(), before);
});
