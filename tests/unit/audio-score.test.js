import test from 'node:test';
import assert from 'node:assert/strict';
import { createScoreScheduler } from '../../src/core/audio-score.js';

function runScore(scheduler, seconds, hz, options) {
  const notes = [];
  for (let i = 0; i < seconds * hz; i++) notes.push(...scheduler.advance(1 / hz, options));
  return notes;
}

test('a score starts with two quiet minor pad voices and no calm pulse', () => {
  const scheduler = createScoreScheduler();
  const notes = scheduler.advance(1 / 60, { zone: 'street' });
  assert.equal(notes.length, 2);
  assert.ok(notes.every(note => note.kind === 'pad'));
  assert.ok(notes.every(note => note.duration >= 2.5 && note.duration <= 4));
  assert.ok(notes.every(note => note.gain >= 0.02 && note.gain <= 0.04));
  assert.equal(scheduler.snapshot().padCount, 1);
  assert.equal(scheduler.snapshot().pulseCount, 0);
});

test('calm score pads remain sparse over sustained play', () => {
  const scheduler = createScoreScheduler();
  const notes = runScore(scheduler, 30, 60, { zone: 'apartment', threat: 0 });
  assert.ok(notes.every(note => note.kind === 'pad'));
  assert.ok(notes.length >= 16 && notes.length <= 20, `${notes.length} pad voices over 30 seconds`);
  assert.equal(notes.length, scheduler.snapshot().padCount * 2);
});

test('threat adds restrained pulses without replacing the pad progression', () => {
  const calm = runScore(createScoreScheduler(), 10, 60, { zone: 'church', threat: 0.2 });
  const tense = runScore(createScoreScheduler(), 10, 60, { zone: 'church', threat: 1 });
  assert.equal(calm.filter(note => note.kind === 'pulse').length, 0);
  const pulses = tense.filter(note => note.kind === 'pulse');
  assert.ok(pulses.length >= 15 && pulses.length <= 20);
  assert.ok(pulses.every(note => note.gain >= 0.035 && note.gain <= 0.07));
  assert.deepEqual(
    calm.filter(note => note.kind === 'pad').map(note => note.frequency),
    tense.filter(note => note.kind === 'pad').map(note => note.frequency),
  );
});

test('zone seeds produce deterministic but varied harmony', () => {
  const zones = ['street', 'church', 'apartment', 'roof', 'dock', 'factory'];
  const initialFrequencies = [];
  for (const zone of zones) {
    const a = createScoreScheduler();
    const b = createScoreScheduler();
    const expected = runScore(a, 12, 60, { zone, threat: 0.7 });
    assert.deepEqual(runScore(b, 12, 60, { zone, threat: 0.7 }), expected);
    assert.deepEqual(a.snapshot(), b.snapshot());
    initialFrequencies.push(expected[0].frequency);
  }
  assert.ok(new Set(initialFrequencies).size >= 3);
});

test('disabled score advances preserve every state field and reuse an empty result', () => {
  const scheduler = createScoreScheduler();
  scheduler.advance(0.1, { zone: 'street', threat: 0.6 });
  const before = scheduler.snapshot();
  const empty = scheduler.advance(30, { zone: 'roof', threat: 1, enabled: false });
  assert.equal(empty.length, 0);
  assert.equal(Object.isFrozen(empty), true);
  for (const enabled of [false, 0, null, 'true']) {
    assert.equal(scheduler.advance(20, { zone: 'church', threat: 1, enabled }), empty);
  }
  assert.deepEqual(scheduler.snapshot(), before);
});

test('zero, negative, non-numeric, and non-finite time never advance or change a score', () => {
  const scheduler = createScoreScheduler();
  scheduler.advance(0.1, { zone: 'dock', threat: 0.4 });
  const before = scheduler.snapshot();
  for (const dt of [0, -0.1, NaN, Infinity, -Infinity, undefined, null, '1', {}, 1n, Symbol('time')]) {
    assert.deepEqual(scheduler.advance(dt, { zone: 'roof', threat: 1 }), []);
    assert.deepEqual(scheduler.snapshot(), before);
  }
});

test('a large frame advances at most one quarter second and cannot queue catch-up notes', () => {
  const options = { zone: 'factory', threat: 1 };
  for (const dt of [1, 60, Number.MAX_VALUE]) {
    const scheduler = createScoreScheduler();
    const expected = createScoreScheduler();
    assert.deepEqual(scheduler.advance(dt, options), expected.advance(0.25, options));
    assert.deepEqual(scheduler.snapshot(), expected.snapshot());
    assert.equal(scheduler.snapshot().elapsed, 0.25);
    for (let i = 0; i < 8; i++) {
      assert.deepEqual(scheduler.advance(0.01, options), expected.advance(0.01, options));
    }
    assert.equal(scheduler.snapshot().padCount, 1);
    assert.equal(scheduler.snapshot().pulseCount, 1);
  }
});

test('paused time is discarded and resumption continues the original deadlines', () => {
  const scheduler = createScoreScheduler();
  const expected = createScoreScheduler();
  const options = { zone: 'apartment', threat: 0.8 };
  assert.deepEqual(runScore(scheduler, 2, 60, options), runScore(expected, 2, 60, options));
  for (let i = 0; i < 100; i++) scheduler.advance(30, { ...options, enabled: false });
  assert.deepEqual(scheduler.snapshot(), expected.snapshot());
  assert.deepEqual(runScore(scheduler, 3, 60, options), runScore(expected, 3, 60, options));
});

test('reset restores the initial state and reproduces the same score', () => {
  const scheduler = createScoreScheduler();
  const initial = scheduler.snapshot();
  const options = { zone: 'roof', threat: 0.9 };
  const first = runScore(scheduler, 10, 60, options);
  scheduler.advance(0.1, { zone: 'street', threat: 0.5 });
  scheduler.reset();
  assert.deepEqual(scheduler.snapshot(), initial);
  assert.deepEqual(runScore(scheduler, 10, 60, options), first);
});

test('threat is clamped and malformed options have safe defaults', () => {
  for (const [value, normalized] of [[-5, 0], [5, 1], [NaN, 0], [Infinity, 0], ['1', 0]]) {
    const scheduler = createScoreScheduler();
    assert.deepEqual(
      scheduler.advance(0.1, { threat: value }),
      createScoreScheduler().advance(0.1, { threat: normalized }),
    );
    assert.equal(scheduler.snapshot().threat, normalized);
  }
  for (const options of [null, undefined, false, 1, 'zone']) {
    assert.deepEqual(createScoreScheduler().advance(0.1, options), createScoreScheduler().advance(0.1));
  }
  assert.deepEqual(createScoreScheduler().advance(0.1, { zone: {} }), createScoreScheduler().advance(0.1));
});

test('all generated notes and per-frame work remain bounded under changing inputs', () => {
  const scheduler = createScoreScheduler();
  for (let i = 0; i < 6000; i++) {
    const notes = scheduler.advance(i % 41 === 0 ? 1000 : 1 / 30, {
      zone: `sector-${Math.floor(i / 137)}`,
      threat: Math.sin(i / 53) * 100,
    });
    assert.ok(notes.length <= 3);
    for (const note of notes) {
      assert.ok(['pad', 'pulse'].includes(note.kind));
      assert.ok(['sine', 'triangle'].includes(note.waveform));
      assert.ok(Number.isFinite(note.frequency) && note.frequency >= 30 && note.frequency <= 400);
      assert.ok(Number.isFinite(note.duration) && note.duration > 0 && note.duration <= 4);
      assert.ok(Number.isFinite(note.gain) && note.gain >= 0.02 && note.gain <= 0.07);
      assert.ok(Number.isFinite(note.cutoff) && note.cutoff >= 100 && note.cutoff <= 1200);
      assert.deepEqual(Object.keys(note).sort(), ['cutoff', 'duration', 'frequency', 'gain', 'kind', 'waveform']);
    }
  }
  assert.ok(Number.isFinite(scheduler.snapshot().elapsed));
});

test('zone changes wait for the next scheduled chord instead of retriggering pads', () => {
  const scheduler = createScoreScheduler();
  scheduler.advance(0.1, { zone: 'street' });
  const nextPadAt = scheduler.snapshot().nextPadAt;
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(scheduler.advance(0.1, { zone: i % 2 ? 'church' : 'factory' }), []);
  }
  assert.equal(scheduler.snapshot().nextPadAt, nextPadAt);
  let nextChord;
  for (let i = 0; i < 40 && !nextChord; i++) {
    const notes = scheduler.advance(0.1, { zone: 'roof' });
    if (notes.length) nextChord = notes;
  }
  assert.deepEqual(nextChord, createScoreScheduler().advance(0.1, { zone: 'roof' }));
});

test('rapid threat fluctuations cannot retrigger the pulse on every rising edge', () => {
  const scheduler = createScoreScheduler();
  const pulseTimes = [];
  for (let i = 0; i < 1200; i++) {
    const notes = scheduler.advance(0.01, { zone: 'street', threat: i % 2 });
    if (notes.some(note => note.kind === 'pulse')) pulseTimes.push(scheduler.snapshot().elapsed);
  }
  assert.ok(pulseTimes.length >= 15 && pulseTimes.length <= 24);
  for (let i = 1; i < pulseTimes.length; i++) assert.ok(pulseTimes[i] - pulseTimes[i - 1] >= 0.53);
});

test('steady score events and harmony remain identical at 30, 60, and 120 Hz', () => {
  const options = { zone: 'dock', threat: 0.9 };
  const expected = runScore(createScoreScheduler(), 30, 120, options);
  assert.deepEqual(runScore(createScoreScheduler(), 30, 60, options), expected);
  assert.deepEqual(runScore(createScoreScheduler(), 30, 30, options), expected);
});

test('long zone names are bounded and returned data cannot mutate scheduler state', () => {
  const scheduler = createScoreScheduler();
  const notes = scheduler.advance(0.1, { zone: 'z'.repeat(10000), threat: 1 });
  const before = scheduler.snapshot();
  assert.equal(before.zone.length, 96);
  notes[0].frequency = NaN;
  notes.length = 0;
  const detached = scheduler.snapshot();
  detached.elapsed = 500;
  detached.zone = 'changed';
  assert.deepEqual(scheduler.snapshot(), before);
});
