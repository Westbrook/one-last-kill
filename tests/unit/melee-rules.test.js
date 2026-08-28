import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { createMeleeState, beginMelee, advanceMelee, cancelMelee, meleeRemaining } from '../../src/game/melee-rules.js';

test('each melee contact follows its windup and occurs once before recovery ends', () => {
  for (const type of ['fists', 'bat', 'knife']) {
    const state = createMeleeState(), definition = WEAPON_DEFS[type];
    assert.ok(definition.attackDuration <= definition.rate);
    assert.ok(definition.contactPhase > 0 && definition.contactPhase < 1);
    assert.equal(beginMelee(state, type), true);
    assert.equal(meleeRemaining(state), 1);
    assert.equal(advanceMelee(state, state.contactAt - 0.001), false);
    assert.equal(state.contactDelivered, false);
    assert.equal(advanceMelee(state, 0.001), true);
    assert.equal(state.contactDelivered, true);
    assert.ok(Math.abs(meleeRemaining(state) - (1 - definition.contactPhase)) < 1e-8);
    assert.equal(advanceMelee(state, definition.attackDuration), false);
    assert.equal(state.active, false);
    assert.equal(meleeRemaining(state), 0);
    assert.equal(advanceMelee(state, 1), false);
  }
});

test('a single longer frame cannot skip or duplicate contact', () => {
  const state = createMeleeState();
  beginMelee(state, 'bat');
  assert.equal(advanceMelee(state, 1), true);
  assert.equal(state.elapsed, WEAPON_DEFS.bat.attackDuration);
  assert.equal(advanceMelee(state, 1), false);
});

test('paused and invalid time leave the complete melee timeline unchanged', () => {
  const state = createMeleeState();
  beginMelee(state, 'fists');
  advanceMelee(state, 0.04);
  const before = { ...state };
  for (const delta of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(advanceMelee(state, delta), false);
    assert.deepEqual(state, before);
  }
});

test('cancellation removes an uncommitted attack without remembering its target', () => {
  const state = createMeleeState();
  beginMelee(state, 'bat');
  advanceMelee(state, 0.1);
  cancelMelee(state);
  assert.equal(advanceMelee(state, 1), false);
  assert.equal(state.type, null);
  assert.equal(state.owner, null);
  assert.equal(state.contactDelivered, false);
  assert.equal(meleeRemaining(state), 0);
  assert.equal(Object.hasOwn(state, 'target'), false);
  assert.equal(beginMelee(state, 'fists', 'pistol'), true);
  assert.equal(state.owner, 'pistol');
  assert.equal(state.sequence, 2);
});

test('an active swing cannot be overwritten and invalid weapon keys are rejected', () => {
  const state = createMeleeState();
  for (const type of ['pistol', 'missing', 'constructor', '__proto__']) assert.equal(beginMelee(state, type), false);
  assert.equal(beginMelee(state, 'bat', 'missing'), false);
  beginMelee(state, 'bat');
  const before = { ...state };
  assert.equal(beginMelee(state, 'fists'), false);
  assert.deepEqual(state, before);
});
