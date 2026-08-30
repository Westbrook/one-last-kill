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

test('off-hand melee visibly punches and restores each carried firearm without dropping it or consuming ammunition', () => {
  for (const current of ['pistol', 'shotgun', 'smg', 'machinegun']) {
    const { Weapons, WeaponDrops, calls, Player } = weaponHarness();
    Weapons.init(); Weapons.restore({ current, loaded: 3, reserve: 11 });
    const firearm = Weapons.vmGroup.children[0], snapshot = Weapons.snapshot();
    Player.aiming = true;
    Weapons.update(1);
    assert.ok(Weapons.aimBlend > 0.99);
    Weapons.handleInput({ vPressed: true }, 1 / 120);
    assert.equal(Weapons.melee.owner, current);
    assert.equal(Weapons.melee.type, 'fists');
    assert.equal(Weapons.vmGroup.children[0], Weapons._vm('fists'));
    assert.equal(firearm.parent, null);
    assert.equal(calls.damage.length, 0);
    Weapons.tick(0.14); Weapons.update(0.14);
    assert.deepEqual(calls.damage, [WEAPON_DEFS.fists.dmg]);
    assert.deepEqual(Weapons.vmGroup.position.toArray(), [0, 0, 0]);
    assert.ok(Weapons.aimBlend < 0.15, 'punching releases aim instead of zooming the fist rig');
    Weapons.tick(WEAPON_DEFS.fists.attackDuration); Weapons.update(0.14);
    assert.equal(Weapons.vmGroup.children[0], firearm, 'the same cached firearm returns after recovery');
    assert.deepEqual(Weapons.snapshot(), snapshot);
    assert.equal(WeaponDrops.list.length, 0);
    assert.equal(calls.shots.length, 0);
    assert.equal(calls.damage.length, 1);
    assert.ok(Weapons.aimBlend > 0.85, 'held aim resumes when the firearm returns');
  }
});

test('a punch takes priority over simultaneous firearm input and finishes before held automatic fire resumes', () => {
  const { Weapons, calls } = weaponHarness();
  Weapons.init(); Weapons.restore({ current: 'smg', loaded: 3, reserve: 11 });
  Weapons.handleInput({ vPressed: true, leftPressed: true, leftDown: true }, 1 / 120);
  for (let frame = 0; frame < 33; frame++) {
    Weapons.tick(0.01);
    Weapons.handleInput({ leftDown: true }, 0.01);
  }
  assert.deepEqual(calls.damage, [WEAPON_DEFS.fists.dmg]);
  assert.equal(calls.shots.length, 0);
  assert.equal(Weapons.melee.sequence, 1);
  assert.equal(Weapons.vmGroup.children[0], Weapons._vm('smg'));
  Weapons.tick(0.02);
  Weapons.handleInput({ leftDown: true }, 0.02);
  assert.deepEqual(calls.damage, [WEAPON_DEFS.fists.dmg, WEAPON_DEFS.smg.dmg]);
  assert.equal(calls.shots.length, 1);
  assert.equal(Weapons.loaded, 2);
});

test('starting a valid reload cancels an off-hand windup before it can hit', () => {
  const { Weapons, calls } = weaponHarness();
  Weapons.init(); Weapons.restore({ current: 'pistol', loaded: 3, reserve: 11 });
  Weapons.handleInput({ vPressed: true }, 1 / 120);
  Weapons.tick(0.05);
  assert.equal(Weapons.startReload(), true);
  assert.equal(Weapons.vmGroup.children[0], Weapons._vm('pistol'));
  Weapons.tick(0.1);
  assert.equal(calls.damage.length, 0); assert.equal(calls.sounds, 0);
  assert.equal(Weapons.melee.active, false);
  assert.equal(Weapons.loaded, 3); assert.equal(Weapons.reserve, 11);
  Weapons.handleInput({ vPressed: true }, 1 / 120);
  assert.equal(Weapons.melee.active, false, 'an active reload cannot overlap another punch');
  Weapons.tick(WEAPON_DEFS.pistol.reloadTime);
  assert.equal(Weapons.loaded, 12); assert.equal(Weapons.reserve, 2);
});

test('off-hand cancellation, equipment changes and death restore the appropriate held view model before contact', () => {
  for (const [interrupt, expected] of [
    [({ Weapons }) => Weapons.cancelAttack(), 'pistol'],
    [({ Weapons }) => Weapons._equip('shotgun', 8), 'shotgun'],
    [({ Weapons }) => Weapons.dropCurrent(), 'fists'],
    [({ Weapons }) => Weapons.restore({ current: 'smg', loaded: 2, reserve: 7 }), 'smg'],
    [({ PlayerState }) => { PlayerState.dead = true; }, 'pistol'],
  ]) {
    const fixture = weaponHarness(), { Weapons, calls } = fixture;
    Weapons.init(); Weapons.restore({ current: 'pistol', loaded: 3, reserve: 11 });
    Weapons.handleInput({ vPressed: true }, 1 / 120);
    Weapons.tick(0.05); interrupt(fixture); Weapons.tick(1);
    assert.equal(Weapons.melee.active, false);
    assert.equal(calls.damage.length, 0);
    assert.equal(Weapons.current, expected);
    assert.equal(Weapons.vmGroup.children[0], Weapons._vm(expected));
    if (expected !== 'fists') {
      assert.deepEqual(Weapons.vmGroup.position.toArray(), Weapons.basePos.toArray(),
        'the firearm anchor is restored before the next rendered frame');
    }
    if (fixture.PlayerState.dead) {
      Weapons.handleInput({ leftPressed: true, gPressed: true }, 1 / 120);
      assert.equal(Weapons.current, 'pistol');
      assert.equal(calls.damage.length, 0);
    }
  }
});

test('paused presentation cannot advance or finish an off-hand punch', () => {
  const { Weapons, calls } = weaponHarness();
  Weapons.init(); Weapons.restore({ current: 'pistol', loaded: 3, reserve: 11 });
  Weapons.handleInput({ vPressed: true }, 1 / 120);
  Weapons.tick(0.05);
  for (let frame = 0; frame < 10; frame++) { Weapons.tick(0); Weapons.update(0); }
  assert.equal(Weapons.melee.elapsed, 0.05);
  assert.equal(Weapons.vmGroup.children[0], Weapons._vm('fists'));
  assert.equal(calls.damage.length, 0);
  Weapons.tick(0.09);
  assert.deepEqual(calls.damage, [WEAPON_DEFS.fists.dmg]);
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
