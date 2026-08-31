import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunSettings, DEFENSE_WAVE_OPTIONS, DIFFICULTY_LEVELS } from '../../src/game/run-settings.js';

test('every fresh run requires an explicit difficulty before gameplay can start', () => {
  const settings = createRunSettings();
  assert.equal(settings.isConfigured(), false);
  assert.equal(settings.snapshot().difficulty, null);
  assert.equal(settings.isStarted(), false);
  assert.throws(() => settings.start(), /Choose a difficulty/);
  for (const difficulty of [undefined, null, '', 'unknown', 'AVERAGE', 2, {}, []]) {
    assert.throws(() => settings.configure({ difficulty }), RangeError);
    assert.equal(settings.isConfigured(), false);
    assert.throws(() => settings.start(), /Choose a difficulty/);
  }
  settings.configure({ difficulty: 'average' });
  assert.equal(settings.isConfigured(), true);
  assert.equal(settings.profile.id, 'average');
  settings.start();
  assert.equal(settings.isStarted(), true);
});

test('a started run keeps all settings immutable through every attempted reconfiguration', () => {
  const changes = [], settings = createRunSettings({ onChange: value => changes.push(value) });
  const input = { difficulty: 'hard', mode: 'defense', arena: 'street', waves: 50 };
  const selected = settings.configure(input);
  input.difficulty = 'easy';
  assert.equal(selected.difficulty, 'hard');
  assert.equal(settings.isLocked(), false);
  const started = settings.start();
  assert.ok(Object.isFrozen(started));
  assert.equal(settings.locked, true);
  assert.throws(() => { started.difficulty = 'easy'; }, TypeError);
  assert.throws(() => { changes[1].locked = false; }, TypeError);
  for (const patch of [{ difficulty: 'easy' }, { mode: 'campaign' }, { arena: 'roof' }, { waves: 10 }, { locked: false }]) {
    assert.throws(() => settings.configure(patch), /locked/);
    assert.equal(settings.snapshot(), started);
  }
  assert.equal(settings.start(), started, 'resuming cannot replace the run snapshot');
  assert.equal(changes.length, 2);
  assert.equal(settings.profile, settings.getDifficulty());
});

test('all allowed defense lengths, arenas and difficulty choices validate before lock', () => {
  for (const profile of DIFFICULTY_LEVELS) for (const waves of DEFENSE_WAVE_OPTIONS) for (const arena of ['roof', 'street']) {
    const settings = createRunSettings();
    settings.configure({ difficulty: profile.id, mode: 'defense', arena, waves });
    const started = settings.start();
    assert.deepEqual(started, { difficulty: profile.id, mode: 'defense', arena, waves, locked: true });
    assert.equal(settings.profile, profile);
  }
});

test('malformed mode, arena and wave count cannot partially modify the selected run', () => {
  const settings = createRunSettings();
  const before = settings.configure({ difficulty: 'easy' });
  for (const patch of [{ mode: 'survival' }, { arena: 'bakery' }, { waves: 0 }, { waves: 15 }, { waves: '20' }, { waves: Infinity }]) {
    assert.throws(() => settings.configure(patch), RangeError);
    assert.equal(settings.snapshot(), before);
  }
  settings.configure({ mode: 'defense', arena: 'street', waves: 20 });
  assert.equal(settings.snapshot().difficulty, 'easy');
});

test('starting another run clears the previous difficulty and requires a fresh selection', () => {
  const settings = createRunSettings();
  settings.configure({ difficulty: 'very-hard', mode: 'defense', arena: 'street', waves: 100 });
  const oldRun = settings.start();
  settings.reset();
  assert.deepEqual(settings.snapshot(), { difficulty: null, mode: 'campaign', arena: 'roof', waves: 10, locked: false });
  assert.throws(() => settings.start(), /Choose a difficulty/);
  settings.configure({ difficulty: 'very-easy' });
  assert.equal(settings.start().difficulty, 'very-easy');
  assert.equal(oldRun.difficulty, 'very-hard');
  assert.equal(oldRun.locked, true);
});
