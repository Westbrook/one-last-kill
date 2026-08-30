import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputState } from '../../src/core/input-state.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { weaponHarness } from './helpers/weapon-harness.js';

test('a fire tap released between frames still fires exactly one round from every firearm', () => {
  const { Weapons, calls } = weaponHarness();
  Weapons.init();
  const input = createInputState();
  input.activate();
  for (const current of ['pistol', 'shotgun', 'smg', 'machinegun']) {
    Weapons.restore({ current, loaded: 3, reserve: 0 });
    const shots = calls.shots.length;
    input.touchButton('fire', true);
    input.touchButton('fire', false);
    const tap = input.consumeFrame();
    assert.equal(tap.leftDown, false);
    assert.equal(tap.leftPressed, true);
    Weapons.handleInput(tap, 1 / 60);
    assert.equal(Weapons.loaded, 2, current + ' accepts the brief tap');
    assert.equal(calls.shots.length, shots + 1);
    for (let frame = 0; frame < 60; frame++) {
      Weapons.tick(1 / 60);
      Weapons.handleInput(input.consumeFrame(), 1 / 60);
    }
    assert.equal(Weapons.loaded, 2, current + ' cannot keep firing after release');
  }
});

test('holding touch fire repeats only automatic weapons and stops on release', () => {
  const { Weapons } = weaponHarness();
  Weapons.init();
  const input = createInputState();
  input.activate();
  for (const current of ['pistol', 'shotgun', 'smg', 'machinegun']) {
    Weapons.restore({ current, loaded: 3, reserve: 0 });
    input.touchButton('fire', true);
    Weapons.handleInput(input.consumeFrame(), 1 / 60);
    assert.equal(Weapons.loaded, 2);
    Weapons.tick(WEAPON_DEFS[current].rate + 0.01);
    Weapons.handleInput(input.consumeFrame(), 1 / 60);
    const remaining = WEAPON_DEFS[current].full ? 1 : 2;
    assert.equal(Weapons.loaded, remaining, current);
    input.touchButton('fire', false);
    Weapons.tick(WEAPON_DEFS[current].rate + 0.01);
    Weapons.handleInput(input.consumeFrame(), 1 / 60);
    assert.equal(Weapons.loaded, remaining, current + ' releases fire');
  }
});
