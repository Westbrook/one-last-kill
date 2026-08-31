import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Group, Vector3 } from 'three';
import { createDefenseSupplies } from '../../src/game/defense-supplies.js';
import { AMMO_RESERVE_LIMITS, ammoSupplyAmount } from '../../src/game/ammo-supply-rules.js';

function fixture({ arena = 'roof', floorAt, blocked = () => false, colliders = [], spawnWeapon, clearWeapons } = {}) {
  const floorY = arena === 'roof' ? 14 : 0.05;
  const world = new Group();
  const player = {
    pos: new Vector3(arena === 'roof' ? 10 : 8, floorY + 1.72, arena === 'roof' ? -6 : 18),
    _eyeH: 1.72, health: 70, armor: 0,
  };
  const session = { active: true };
  const weapons = {
    current: 'pistol', loaded: 3, reserve: 0,
    acceptReserveAmmo(amount, cap) {
      const accepted = Math.max(0, Math.min(amount, cap - this.reserve));
      this.reserve += accepted;
      return accepted;
    },
  };
  const events = [];
  const supplies = createDefenseSupplies();
  const initialization = {
    world, player, weapons, canCollect: () => session.active,
    floorAt: floorAt || (() => floorY), blocked, colliders,
    onCollect: event => events.push(event), spawnWeapon, clearWeapons,
  };
  supplies.init(initialization);
  const refill = (wave = 3, difficulty = 'average') => supplies.refill({ arena, wave, difficulty });
  const entry = kind => supplies.list.find(supply => supply.kind === kind);
  const approach = kind => {
    const target = entry(kind);
    player.pos.set(target.mesh.position.x, target.floorY + player._eyeH, target.mesh.position.z);
    return target;
  };
  return { world, player, weapons, session, events, supplies, refill, entry, approach, floorY, initialization };
}

test('each wave gets finite pooled supplies and an already issued wave cannot be farmed', () => {
  const { world, player, supplies, refill, approach } = fixture();
  const initial = refill();
  assert.equal(initial.pending, false);
  assert.equal(initial.active, 3);
  assert.deepEqual(new Set(initial.supplies.map(supply => supply.kind)), new Set(['ammo', 'health', 'armor']));
  assert.ok(initial.supplies.every(supply => supply.active && supply.amount > 0 && Number.isFinite(supply.amount)));
  assert.doesNotThrow(() => JSON.stringify(initial));
  const models = supplies.list.map(supply => supply.mesh);
  const geometry = new Set(), materials = new Set();
  world.traverse(object => {
    if (object.geometry) geometry.add(object.geometry);
    if (object.material) materials.add(object.material);
  });
  player.health = 1;
  approach('health'); supplies.update(1 / 60);
  const consumed = supplies.snapshot();
  assert.equal(consumed.supplies.find(supply => supply.kind === 'health').active, false);
  assert.deepEqual(refill(), consumed, 'Repeating the current wave preserves spent supplies');
  assert.deepEqual(refill(3, 'easy'), consumed, 'Changing a repeat request cannot replenish the wave');
  assert.equal(initial.supplies.find(supply => supply.kind === 'health').active, true, 'Snapshots do not retain live entries');

  for (let wave = 4; wave <= 12; wave++) {
    const next = refill(wave);
    assert.equal(next.active, 3);
    assert.deepEqual(supplies.list.map(supply => supply.mesh), models);
    assert.deepEqual(refill(wave - 1), next, 'Earlier waves also cannot refill an existing run');
    world.traverse(object => {
      if (object.geometry) assert.ok(geometry.has(object.geometry));
      if (object.material) assert.ok(materials.has(object.material));
    });
  }
  supplies.clear();
  assert.ok(supplies.list.every(supply => !supply.active && !supply.mesh.visible));
  assert.equal(refill().active, 3, 'Clearing the run permits a fresh supply distribution');
  assert.deepEqual(supplies.list.map(supply => supply.mesh), models);
});

test('ammunition tops up only the held ranged reserve and is consumed once', () => {
  const { supplies, weapons, events, refill, approach } = fixture();
  refill();
  const ammo = approach('ammo');
  const expected = ammoSupplyAmount(weapons, ammo.amount);
  assert.ok(expected > 0);
  supplies.update(1 / 60);
  assert.equal(weapons.reserve, expected);
  assert.equal(weapons.loaded, 3, 'A supply pickup does not bypass reloading');
  assert.equal(weapons.current, 'pistol', 'A supply pickup cannot unlock a weapon');
  assert.equal(ammo.active, false);
  assert.equal(ammo.mesh.visible, false);
  assert.equal(events.length, 1);
  supplies.update(30);
  assert.equal(weapons.reserve, expected);
  assert.equal(events.length, 1);

  refill(4);
  approach('ammo'); weapons.reserve = AMMO_RESERVE_LIMITS.pistol - 1;
  supplies.update(1 / 60);
  assert.equal(weapons.reserve, AMMO_RESERVE_LIMITS.pistol);
  assert.equal(ammo.active, false, 'A partially useful package remains a finite single pickup');
});

test('full resources, melee weapons, and failed ammo acceptance preserve supplies', () => {
  const { supplies, weapons, player, events, refill, approach } = fixture();
  refill();
  const ammo = approach('ammo');
  for (const current of ['fists', 'bat', 'knife']) {
    weapons.current = current;
    supplies.update(1 / 60);
    assert.equal(ammo.active, true);
    assert.equal(weapons.current, current);
    assert.equal(weapons.reserve, 0);
  }
  weapons.current = 'pistol'; weapons.reserve = AMMO_RESERVE_LIMITS.pistol;
  supplies.update(1 / 60);
  assert.equal(ammo.active, true);
  weapons.reserve = 0;
  weapons.acceptReserveAmmo = () => 0;
  supplies.update(1 / 60);
  assert.equal(ammo.active, true);
  assert.equal(weapons.loaded, 3);

  const health = approach('health'); player.health = 100;
  supplies.update(1 / 60);
  assert.equal(health.active, true);
  const armor = approach('armor'); player.armor = 100;
  supplies.update(1 / 60);
  assert.equal(armor.active, true);
  assert.equal(events.length, 0);
});

test('health is capped and a defense vest replaces weaker armor without adding to it', () => {
  const { supplies, player, events, refill, approach } = fixture();
  refill();
  const health = approach('health');
  player.health = 100 - Math.min(1, health.amount / 2);
  supplies.update(1 / 60);
  assert.equal(player.health, 100);
  assert.equal(health.active, false);
  const armor = approach('armor');
  player.armor = armor.amount - 1;
  supplies.update(1 / 60);
  assert.equal(player.armor, armor.amount);
  assert.equal(armor.active, false);
  const after = { health: player.health, armor: player.armor };
  supplies.update(60);
  assert.deepEqual({ health: player.health, armor: player.armor }, after);
  assert.equal(events.length, 2);
});

test('paused sessions, dead players, and another floor cannot collect nearby packages', () => {
  const { supplies, player, weapons, session, events, refill, approach } = fixture({ arena: 'street' });
  refill();
  const ammo = approach('ammo');
  session.active = false;
  supplies.update(1);
  assert.equal(ammo.active, true);
  session.active = true; player.health = 0;
  supplies.update(1);
  assert.equal(ammo.active, true);
  player.health = 100; player.pos.y += 4;
  supplies.update(1);
  assert.equal(ammo.active, true);
  assert.equal(weapons.reserve, 0);
  assert.equal(events.length, 0);
  approach('ammo'); supplies.update(1 / 60);
  assert.equal(ammo.active, false);
  assert.ok(weapons.reserve > 0);
});

test('wave supplies defer while the player has no valid floor and appear after landing', () => {
  let supported = false;
  const weapons = [];
  const { supplies, player, refill } = fixture({
    floorAt: () => supported ? 14 : -Infinity,
    spawnWeapon: weapon => weapons.push(weapon),
  });
  const deferred = refill();
  assert.equal(deferred.pending, true);
  assert.equal(deferred.active, 0);
  assert.equal(weapons.length, 0);
  assert.ok(supplies.list.every(supply => !supply.active && !supply.mesh.visible));
  supported = true;
  player.pos.y += 3;
  supplies.update(1 / 60);
  assert.equal(supplies.snapshot().active, 0, 'An airborne player cannot seed floating packages');
  assert.equal(weapons.length, 0);
  player.pos.y = 14 + player._eyeH;
  supplies.update(1 / 60);
  assert.equal(supplies.snapshot().pending, false);
  assert.equal(supplies.snapshot().active, 3);
  assert.ok(supplies.list.every(supply => supply.floorY === 14));
  assert.equal(weapons.length, 1);
  supplies.update(1 / 60);
  assert.equal(weapons.length, 1, 'Landing issues the pending weapon once');
});

test('placement avoids blocking geometry and checks the whole package against floor holes', () => {
  const wall = new Box3(new Vector3(8.5, 14, -8.6), new Vector3(11.5, 17, -7.4));
  const floorAt = point => point.x <= 10.25 ? 14 : -Infinity;
  const blocked = point => wall.containsPoint(point);
  const { supplies, refill } = fixture({ floorAt, blocked, colliders: [wall] });
  const result = refill();
  assert.equal(result.active, 3, 'Open supported space around the player remains usable');
  for (const supply of supplies.list) {
    const bounds = new Box3().setFromObject(supply.mesh);
    assert.equal(bounds.intersectsBox(wall), false, supply.kind);
    assert.equal(floorAt(supply.mesh.position), 14, supply.kind);
    assert.ok(bounds.max.x <= 10.25, `${supply.kind} must not hang over unsupported space`);
    assert.ok(bounds.min.y >= 14 - 1e-6, `${supply.kind} must not penetrate its floor`);
  }
});

test('weapon resupply preserves progression, expires old drops, and keeps pickups apart', () => {
  const pickups = [];
  let cleared = 0;
  const { supplies, weapons, refill } = fixture({
    spawnWeapon: pickup => pickups.push(pickup),
    clearWeapons: () => { pickups.length = 0; cleared++; },
  });
  weapons.current = 'fists'; weapons.loaded = 0;
  const opening = refill(1);
  assert.deepEqual(pickups.map(pickup => pickup.type), ['bat']);
  assert.equal(opening.supplies.find(supply => supply.kind === 'ammo').active, false);
  refill(2);
  assert.equal(pickups.length, 0, 'Unclaimed weapons expire before the next distribution');
  const pistolWave = refill(3);
  assert.deepEqual(pickups.map(pickup => pickup.type), ['pistol']);
  assert.ok(pickups[0].ammo > 0);
  assert.equal(weapons.current, 'fists', 'The unlocked gun remains a world pickup');
  const previousClears = cleared;
  assert.deepEqual(refill(3), pistolWave);
  assert.equal(pickups.length, 1);
  assert.equal(cleared, previousClears, 'An idempotent refill does not delete an existing weapon');
  refill(9);
  assert.deepEqual(pickups.map(pickup => pickup.type), ['smg']);
  const heavyWave = refill(12);
  assert.deepEqual(new Set(pickups.map(pickup => pickup.type)), new Set(['shotgun', 'machinegun']));
  assert.deepEqual(heavyWave.weapons, pickups);
  const positions = [
    ...supplies.list.filter(supply => supply.active).map(supply => supply.mesh.position),
    ...pickups.map(pickup => pickup.position),
  ];
  for (const [index, position] of positions.entries()) {
    assert.ok(['x', 'y', 'z'].every(axis => Number.isFinite(position[axis])));
    for (const other of positions.slice(index + 1)) {
      assert.ok(Math.hypot(position.x - other.x, position.z - other.z) >= 1,
        'Separate packages remain individually approachable');
    }
  }
  supplies.reset();
  assert.equal(pickups.length, 0);
  assert.equal(supplies.snapshot().weapons.length, 0);
});

test('invalid settings cannot erase an issued distribution or consume a wave number', () => {
  const { supplies, refill } = fixture();
  const current = refill();
  assert.throws(() => refill(4, 'invalid-difficulty'), RangeError);
  assert.deepEqual(supplies.snapshot(), current);
  assert.deepEqual(refill(101), current);
  assert.deepEqual(supplies.refill({ arena: 'unknown', wave: 4, difficulty: 'average' }), current);
  assert.equal(refill(4).wave, 4, 'A rejected request does not latch a future wave');
});

test('reinitializing reuses the same resources and transfers collection to the new world callbacks', () => {
  const { world, supplies, refill, approach, initialization, events } = fixture();
  refill();
  const models = supplies.list.map(supply => supply.mesh), nextWorld = new Group(), nextEvents = [];
  supplies.init({ ...initialization, world: nextWorld, onCollect: event => nextEvents.push(event) });
  assert.equal(supplies.snapshot().active, 0);
  assert.equal(world.children.length, 0);
  assert.equal(nextWorld.children.length, 3);
  assert.deepEqual(supplies.list.map(supply => supply.mesh), models);
  refill(); approach('ammo'); supplies.update(1 / 60);
  assert.equal(events.length, 0);
  assert.equal(nextEvents.length, 1);
});

test('a partially placed distribution retries without moving issued supplies or restoring collected ammo', () => {
  let passageOpen = false;
  const pickups = [];
  const { supplies, weapons, refill, approach, entry } = fixture({
    blocked: point => !passageOpen
      && (point.x < 9.7 || point.x > 10.7 || point.z < -6.3 || point.z > -3.7),
    spawnWeapon: pickup => pickups.push(pickup),
  });
  const partial = refill();
  assert.equal(partial.pending, true);
  assert.equal(partial.active, 1, 'The narrow passage fits only the first package');
  assert.equal(entry('ammo').active, true);
  assert.equal(pickups.length, 0);

  const ammo = approach('ammo'), ammoPosition = ammo.mesh.position.clone();
  supplies.update(1 / 60);
  assert.equal(ammo.active, false);
  assert.equal(ammo.issued, true);
  assert.ok(weapons.reserve > 0);
  assert.equal(supplies.snapshot().pending, true);
  const reserve = weapons.reserve;
  const alreadyPlaced = supplies.snapshot().supplies.filter(supply => supply.active);
  passageOpen = true;
  supplies.update(0.6);
  const completed = supplies.snapshot();
  assert.equal(completed.pending, false);
  assert.equal(completed.active, 2);
  assert.equal(entry('health').active, true);
  assert.equal(entry('armor').active, true);
  assert.equal(ammo.active, false, 'A later placement retry cannot restore spent ammunition');
  assert.equal(ammo.issued, true);
  assert.deepEqual(ammo.mesh.position, ammoPosition);
  assert.equal(weapons.reserve, reserve);
  assert.deepEqual(pickups.map(pickup => pickup.type), ['pistol']);
  for (const previous of alreadyPlaced) {
    const current = completed.supplies.find(supply => supply.kind === previous.kind);
    assert.equal(current.position.x, previous.position.x);
    assert.equal(current.position.z, previous.position.z);
  }
  supplies.update(1);
  assert.equal(pickups.length, 1);
  assert.equal(ammo.active, false);
  assert.deepEqual(refill(), supplies.snapshot(), 'The same wave remains finite after all placement retries');
});

test('failed weapon placement retries only the missing weapon and preserves an issued gun', () => {
  let canPlaceMachinegun = false;
  const pickups = [];
  const { supplies, refill } = fixture({
    spawnWeapon: pickup => {
      if (pickup.type === 'machinegun' && !canPlaceMachinegun) return false;
      pickups.push(pickup);
      return true;
    },
  });
  const partial = refill(12);
  assert.equal(partial.pending, true);
  assert.equal(partial.active, 3);
  assert.deepEqual(pickups.map(pickup => pickup.type), ['shotgun']);
  const shotgun = partial.weapons[0];
  canPlaceMachinegun = true;
  supplies.update(0.6);
  const complete = supplies.snapshot();
  assert.equal(complete.pending, false);
  assert.deepEqual(pickups.map(pickup => pickup.type), ['shotgun', 'machinegun']);
  assert.deepEqual(complete.weapons.find(pickup => pickup.type === 'shotgun'), shotgun);
  supplies.update(1);
  assert.equal(pickups.length, 2, 'Placement retries cannot duplicate already issued weapons');
});

test('standing on raised cover keeps supplies pending until the player reaches the arena floor', () => {
  const pickups = [];
  const { supplies, player, refill } = fixture({
    floorAt: point => Math.hypot(point.x - 10, point.z + 6) < 0.6 ? 14.8 : 14,
    spawnWeapon: pickup => pickups.push(pickup),
  });
  player.pos.y = 14.8 + player._eyeH;
  const deferred = refill();
  assert.equal(deferred.pending, true);
  assert.equal(deferred.active, 0);
  assert.equal(pickups.length, 0);
  supplies.update(0.6);
  assert.equal(supplies.snapshot().pending, true);
  assert.equal(supplies.snapshot().active, 0);
  player.pos.set(12, 14 + player._eyeH, -6);
  supplies.update(1 / 60);
  assert.equal(supplies.snapshot().pending, false);
  assert.equal(supplies.snapshot().active, 3);
  assert.ok(supplies.list.every(supply => supply.floorY === 14));
  assert.deepEqual(pickups.map(pickup => pickup.type), ['pistol']);
});
