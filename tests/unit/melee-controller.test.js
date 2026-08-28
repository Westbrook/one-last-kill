import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { weaponHarness } from './helpers/weapon-harness.js';

test('real player melee queries and damages only at the visible contact time', () => {
  for (const type of ['fists', 'bat', 'knife']) {
    const { Weapons, calls } = weaponHarness();
    Weapons.init(); Weapons.restore({ current: type, loaded: 0, reserve: 0 });
    const def = WEAPON_DEFS[type], contact = def.attackDuration * def.contactPhase;
    Weapons.handleInput({ leftPressed: true }, 1 / 120);
    assert.equal(calls.damage.length, 0); assert.equal(calls.ranges.length, 0);
    Weapons.tick(contact - 0.001);
    assert.equal(calls.damage.length, 0);
    Weapons.tick(0.001);
    assert.deepEqual(calls.damage, [def.dmg]);
    assert.equal(calls.sounds, 1);
    assert.equal(calls.hits.length, 1);
    Weapons.tick(def.rate);
    assert.equal(calls.damage.length, 1);
    assert.equal(Weapons.melee.active, false);
    assert.equal(Weapons.swingT, 0);
  }
});

test('an enemy leaving the contact query during windup cannot receive a stale hit', () => {
  const { Weapons, calls, ray } = weaponHarness();
  Weapons.init(); Weapons.restore({ current: 'bat', loaded: 0, reserve: 0 });
  Weapons.handleInput({ leftPressed: true }, 1 / 120);
  Weapons.tick(0.12);
  ray.query = () => null; // Range or occlusion is now different at impact.
  Weapons.tick(0.13);
  assert.equal(calls.damage.length, 0); assert.equal(calls.sounds, 0);
  assert.equal(calls.hits.length, 0);
  assert.equal(Weapons.melee.contactDelivered, true, 'a miss spends the swing once');
});

test('the bat contact fan selects just the nearest eligible actor', () => {
  const { Weapons, calls, ray } = weaponHarness();
  const far = { alive: true, health: 150 }, near = { alive: true, health: 150 };
  ray.query = (_origin, direction) => ({ enemy: direction.x > 0 ? near : far,
    dist: direction.x > 0 ? 0.9 : 1.3, part: 'body', point: new THREE.Vector3(direction.x, 0, -1) });
  Weapons.init(); Weapons.restore({ current: 'bat', loaded: 0, reserve: 0 });
  Weapons.handleInput({ leftPressed: true }, 1 / 120);
  Weapons.tick(0.25);
  assert.equal(far.health, 150);
  assert.equal(near.health, 150 - WEAPON_DEFS.bat.dmg);
  assert.equal(calls.damage.length, 1);
  assert.equal(calls.ranges.length, 3);
});

test('equip, drop, restore, explicit cancellation and death cancel pending player melee', () => {
  for (const interrupt of [
    ({ Weapons }) => Weapons._equip('pistol', 12),
    ({ Weapons }) => Weapons.dropCurrent(),
    ({ Weapons }) => Weapons.restore({ current: 'bat', loaded: 0, reserve: 0 }),
    ({ Weapons }) => Weapons.cancelAttack(),
    ({ PlayerState }) => { PlayerState.dead = true; },
  ]) {
    const fixture = weaponHarness(), { Weapons, calls } = fixture;
    Weapons.init(); Weapons.restore({ current: 'bat', loaded: 0, reserve: 0 });
    Weapons.handleInput({ leftPressed: true }, 1 / 120);
    Weapons.tick(0.1); interrupt(fixture); Weapons.tick(1);
    assert.equal(calls.damage.length, 0);
    assert.equal(Weapons.melee.active, false);
  }
});

test('off-hand melee preserves the carried firearm and ammunition', () => {
  const { Weapons, calls } = weaponHarness();
  Weapons.init(); Weapons.restore({ current: 'pistol', loaded: 3, reserve: 11 });
  Weapons.handleInput({ vPressed: true }, 1 / 120);
  assert.equal(Weapons.melee.owner, 'pistol');
  assert.equal(Weapons.melee.type, 'fists');
  assert.equal(calls.damage.length, 0);
  Weapons.tick(0.14);
  assert.deepEqual(calls.damage, [WEAPON_DEFS.fists.dmg]);
  assert.equal(Weapons.current, 'pistol'); assert.equal(Weapons.loaded, 3); assert.equal(Weapons.reserve, 11);
});

test('starting a valid reload cancels an off-hand windup before it can hit', () => {
  const { Weapons, calls } = weaponHarness();
  Weapons.init(); Weapons.restore({ current: 'pistol', loaded: 3, reserve: 11 });
  Weapons.handleInput({ vPressed: true }, 1 / 120);
  Weapons.tick(0.05);
  assert.equal(Weapons.startReload(), true);
  Weapons.tick(0.1);
  assert.equal(calls.damage.length, 0); assert.equal(calls.sounds, 0);
  assert.equal(Weapons.melee.active, false);
  assert.equal(Weapons.loaded, 3); assert.equal(Weapons.reserve, 11);
  Weapons.tick(WEAPON_DEFS.pistol.reloadTime);
  assert.equal(Weapons.loaded, 12); assert.equal(Weapons.reserve, 2);
});

test('holding a semi-automatic melee button cannot invent another swing', () => {
  const { Weapons, calls } = weaponHarness();
  Weapons.init();
  Weapons.handleInput({ leftPressed: true, leftDown: true }, 1 / 120);
  for (let frame = 0; frame < 180; frame++) {
    Weapons.tick(1 / 120);
    Weapons.handleInput({ leftDown: true }, 1 / 120);
  }
  assert.equal(calls.damage.length, 1);
  assert.equal(Weapons.melee.sequence, 1);
});

test('reserve acceptance never equips, reloads, wastes a partial magazine or lowers richer reserves', () => {
  const { Weapons } = weaponHarness();
  Weapons.init();
  assert.equal(Weapons.acceptReserveAmmo(24, 48), 0);
  assert.equal(Weapons.current, 'fists');
  Weapons.restore({ current: 'pistol', loaded: 3, reserve: 45 });
  assert.equal(Weapons.acceptReserveAmmo(24, 48), 3);
  assert.equal(Weapons.loaded, 3); assert.equal(Weapons.reserve, 48);
  assert.equal(Weapons.reloading, 0);
  assert.equal(Weapons.acceptReserveAmmo(24, 48), 0);
  Weapons.reserve = 60;
  assert.equal(Weapons.acceptReserveAmmo(24, 48), 0);
  assert.equal(Weapons.reserve, 60);
  for (const amount of [-1, NaN, Infinity]) assert.equal(Weapons.acceptReserveAmmo(amount, 100), 0);
});
