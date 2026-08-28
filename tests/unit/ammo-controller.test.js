import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { weaponHarness } from './helpers/weapon-harness.js';
import { createAmmoSupplies } from '../../src/game/ammo-supplies.js';
import {
  AMMO_SUPPLY_CACHES, AMMO_SUPPLY_LOADS, AMMO_SUPPLY_COSTS, AMMO_RESERVE_LIMITS,
} from '../../src/game/ammo-supply-rules.js';
import { WEAPON_DEFS } from '../../src/game/weapon-data.js';
import { Colliders } from '../../src/core/collision.js';
import { Architecture, boxBounds } from '../../src/world/architecture.js';
import { BALCONY, OPENINGS } from '../../src/world/layout.js';

const config = AMMO_SUPPLY_CACHES[0];
const dt = 1 / 120;
const snapshot = weapons => ({ ...weapons.snapshot() });
const pressE = weapons => weapons.handleInput({ ePressed: true }, dt);

function fixture(held = { current: 'pistol', loaded: 3, reserve: 2 }, caches = [config]) {
  Architecture.clear(); Colliders.clear();
  const supplies = createAmmoSupplies(caches);
  const game = weaponHarness({ supplies, colliders: Colliders });
  const { World, Player, PlayerState, Weapons } = game;
  const wallX = OPENINGS.balconyStair.max[0] + 1;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.2), new THREE.MeshStandardMaterial());
  wall.position.set(wallX, config.floorY + 1, 0); World.add(wall);
  const wallCollider = Colliders.addBoxBySize(wallX, config.floorY + 1, 0, 2, 2, 0.2);
  Architecture.register(wall, wallCollider, boxBounds(wallX, config.floorY + 1, 0, 2, 2, 0.2), {
    id: 'stair-south-door-east', kind: 'wall',
  });
  // The finite floor supports drops on either side of the wall, so an
  // occlusion test cannot pass merely because the far pickup has no floor.
  Colliders.addBoxBySize(wallX, config.floorY - 0.1, -0.1, 10, 0.2, 3.8);
  for (const cache of caches.filter(entry => entry.zone === 'roof')) {
    // Simple supported interaction fixtures; the separate ammo-layout suite
    // walks these cases against the complete real rooftop builder and cover.
    Colliders.addBoxBySize(cache.position.x, cache.floorY - 0.1, cache.position.z, 5, 0.2, 5);
  }
  Player.pos.set(config.position.x, config.floorY + Player._eyeH, BALCONY.laneZ);
  const session = { active: true };
  supplies.init({ world: World, player: Player, canInteract: () => session.active && !PlayerState.dead });
  supplies.setZone('balcony');
  Weapons.init(); Weapons.restore(held);
  return { ...game, supplies, cache: supplies.list[0], session };
}

test('one E press takes only the nearer cache when a weapon drop is also reachable', () => {
  const { Weapons, WeaponDrops, Player, supplies, cache, calls } = fixture();
  const drop = WeaponDrops.spawn(Player.pos.x + 1, config.floorY, Player.pos.z, 'shotgun', 6);
  const origin = new THREE.Vector3(Player.pos.x, config.floorY + 0.95, Player.pos.z);
  assert.ok(drop.mesh.position.distanceTo(origin) < 1.8, 'The competing drop is inside pickup range');
  assert.equal(supplies.findNearest(Weapons), cache);
  assert.equal(Weapons.findNearestPickup(), cache);

  pressE(Weapons);

  assert.deepEqual(snapshot(Weapons), { current: 'pistol', loaded: 3, reserve: 26 });
  assert.equal(cache.remainingUnits, 0);
  assert.equal(WeaponDrops.list.length, 1);
  assert.equal(WeaponDrops.list[0], drop, 'The same E edge cannot also swap weapons');
  assert.equal(calls.pickups, 1, 'Audio is a counted no-op service, never a sound device');
  assert.equal(calls.messages.length, 1);
  assert.equal(Weapons.findNearestPickup(), drop, 'A subsequent E edge can choose the remaining drop');
  Weapons.handleInput({}, dt);
  assert.equal(WeaponDrops.list.length, 1);
  assert.equal(calls.pickups, 1);
});

test('one E press takes a nearer weapon drop without also spending cache stock', () => {
  const { Weapons, WeaponDrops, Player, supplies, cache, calls } = fixture();
  Player.pos.z = 1.4;
  const drop = WeaponDrops.spawn(Player.pos.x, config.floorY, Player.pos.z, 'pistol', 9);
  assert.equal(supplies.findNearest(Weapons), cache, 'The cache is still a valid competing interaction');
  assert.equal(Weapons.findNearestPickup(), drop);

  pressE(Weapons);

  assert.deepEqual(snapshot(Weapons), { current: 'pistol', loaded: 3, reserve: 11 });
  assert.equal(WeaponDrops.list.includes(drop), false);
  assert.equal(cache.remainingUnits, config.units);
  assert.equal(calls.pickups, 1);
  assert.equal(calls.messages.length, 1);
});

test('melee equipment cannot draw cache ammunition or receive an unearned firearm', () => {
  const { Weapons, WeaponDrops, Player, cache, calls } = fixture();
  for (const current of ['fists', 'bat', 'knife']) {
    Weapons.restore({ current, loaded: 0, reserve: 0 });
    assert.equal(Weapons.findNearestPickup(), null);
    pressE(Weapons);
    assert.equal(Weapons.pickup(cache), false, 'A retained cache reference obeys the same weapon restriction');
    assert.deepEqual(snapshot(Weapons), { current, loaded: 0, reserve: 0 });
    assert.equal(cache.remainingUnits, config.units);
    assert.equal(WeaponDrops.list.length, 0);
    assert.equal(calls.pickups, 0);
  }

  // A real drop, not the floor box, is the positive control for earning a gun.
  Weapons.restore({ current: 'fists', loaded: 0, reserve: 0 });
  const drop = WeaponDrops.spawn(Player.pos.x, config.floorY, Player.pos.z, 'pistol', 9);
  assert.equal(Weapons.findNearestPickup(), drop);
  pressE(Weapons);
  assert.deepEqual(snapshot(Weapons), { current: 'pistol', loaded: 9, reserve: 0 });
  assert.equal(cache.remainingUnits, config.units);
  assert.equal(WeaponDrops.list.length, 0, 'Fists do not become a dropped weapon');
  assert.equal(calls.pickups, 1);
});

test('every cache grant adds only the carried reserve and waits for an explicit reload', () => {
  const { Weapons, WeaponDrops, supplies, cache, calls } = fixture();
  for (const [current, grant] of Object.entries(AMMO_SUPPLY_LOADS)) {
    supplies.reset(); supplies.setZone('balcony');
    Weapons.restore({ current, loaded: 0, reserve: 2 });
    const pickups = calls.pickups;
    pressE(Weapons);
    const expected = { current, loaded: 0, reserve: 2 + grant };
    assert.deepEqual(snapshot(Weapons), expected, current);
    assert.equal(Weapons.reloading, 0, `${current}: E cannot start reloading`);
    assert.equal(cache.remainingUnits, 0);
    assert.equal(calls.pickups, pickups + 1);
    assert.equal(WeaponDrops.list.length, 0, 'Refilling cannot swap or duplicate held equipment');

    Weapons.tick(WEAPON_DEFS[current].reloadTime + 1);
    assert.deepEqual(snapshot(Weapons), expected, `${current}: idle time does not move reserve into the magazine`);
    Weapons.handleInput({ rPressed: true }, dt);
    assert.ok(Weapons.reloading > 0);
    assert.deepEqual(snapshot(Weapons), expected, 'Starting reload does not create ammunition');
    Weapons.tick(WEAPON_DEFS[current].reloadTime);
    const loaded = Math.min(WEAPON_DEFS[current].mag, expected.reserve);
    assert.deepEqual(snapshot(Weapons), { current, loaded, reserve: expected.reserve - loaded });
    assert.equal(Weapons.totalAmmo(), expected.reserve);
    assert.equal(calls.pickups, pickups + 1);
  }
});

test('partial controller refills share one finite budget across weapon swaps', () => {
  const { Weapons, supplies, cache, calls } = fixture({ current: 'pistol', loaded: 3, reserve: 47 });
  pressE(Weapons);
  assert.deepEqual(snapshot(Weapons), { current: 'pistol', loaded: 3, reserve: AMMO_RESERVE_LIMITS.pistol });
  const afterPistol = config.units - AMMO_SUPPLY_COSTS.pistol;
  assert.equal(cache.remainingUnits, afterPistol);
  pressE(Weapons);
  assert.equal(calls.pickups, 1, 'Full reserves cannot spend stock again');
  assert.equal(cache.remainingUnits, afterPistol);

  Weapons.restore({ current: 'smg', loaded: 5, reserve: 0 });
  const smgRounds = Math.floor(afterPistol / AMMO_SUPPLY_COSTS.smg);
  pressE(Weapons);
  assert.deepEqual(snapshot(Weapons), { current: 'smg', loaded: 5, reserve: smgRounds });
  const residual = afterPistol - smgRounds * AMMO_SUPPLY_COSTS.smg;
  assert.equal(cache.remainingUnits, residual);
  Weapons.restore({ current: 'pistol', loaded: 2, reserve: 0 });
  assert.equal(Weapons.pickup(cache), false, 'Residual units cannot be rounded up into a pistol round');

  Weapons.restore({ current: 'machinegun', loaded: 7, reserve: 0 });
  pressE(Weapons);
  assert.deepEqual(snapshot(Weapons), { current: 'machinegun', loaded: 7, reserve: residual / AMMO_SUPPLY_COSTS.machinegun });
  assert.equal(cache.remainingUnits, 0);
  assert.equal(calls.pickups, 3);
  assert.equal(supplies.findNearest(Weapons), null);
});

test('consumed and cleared weapon-drop references cannot duplicate ammunition or equipment', () => {
  for (const weaponType of ['pistol', 'shotgun']) {
    const { Weapons, WeaponDrops, Player, cache, calls } = fixture();
    const drop = WeaponDrops.spawn(Player.pos.x, config.floorY, Player.pos.z, weaponType, 9);
    assert.equal(Weapons.pickup(drop), true);
    const accepted = snapshot(Weapons), pickups = calls.pickups, remainingDrops = [...WeaponDrops.list];
    for (let retry = 0; retry < 4; retry++) {
      assert.equal(Weapons.pickup(drop), false);
      assert.equal(Weapons.pickup({ ...drop }), false);
      assert.deepEqual(snapshot(Weapons), accepted);
      assert.deepEqual([...WeaponDrops.list], remainingDrops);
      assert.equal(calls.pickups, pickups);
      assert.equal(cache.remainingUnits, config.units);
    }
    const uncollected = WeaponDrops.spawn(Player.pos.x + 1, config.floorY, Player.pos.z, 'smg', 30);
    WeaponDrops.clearAll();
    assert.equal(Weapons.pickup(uncollected), false, 'A reference retained across reset is no longer owned by the drop registry');
    assert.deepEqual(snapshot(Weapons), accepted);
    assert.equal(calls.pickups, pickups);
  }
});

test('wall, death, pause, range, floor and zone checks reject controller cache collection', () => {
  const cases = [
    ['wall', ({ Player }) => { Player.pos.z = -0.7; }],
    ['dead', ({ PlayerState }) => { PlayerState.dead = true; }],
    ['paused', ({ session }) => { session.active = false; }],
    ['range', ({ Player }) => { Player.pos.x -= 5; }],
    ['floor', ({ Player }) => { Player.pos.y += 2.4; }],
    ['zone', ({ supplies }) => { supplies.setZone('roof'); }],
  ];
  for (const [label, change] of cases) {
    const game = fixture(), { Weapons, cache, calls } = game;
    const before = snapshot(Weapons);
    assert.equal(Weapons.findNearestPickup(), cache, `${label}: positive control before changing the condition`);
    change(game);
    assert.equal(Weapons.findNearestPickup(), null, label);
    pressE(Weapons);
    assert.equal(Weapons.pickup(cache), false, `${label}: retained cache references are revalidated`);
    assert.deepEqual(snapshot(Weapons), before, label);
    assert.equal(cache.remainingUnits, config.units, label);
    assert.equal(calls.pickups, 0, label);
    assert.equal(calls.messages.length, 0, label);
  }
});

test('E cannot select a weapon through a wall and death rejects its retained reference', () => {
  const { Weapons, WeaponDrops, Player, PlayerState, cache, calls } = fixture({ current: 'fists', loaded: 0, reserve: 0 });
  Player.pos.z = 0.7;
  const drop = WeaponDrops.spawn(Player.pos.x, config.floorY, -0.7, 'pistol', 9);
  const origin = new THREE.Vector3(Player.pos.x, config.floorY + 0.95, Player.pos.z);
  assert.ok(origin.distanceTo(drop.mesh.position) < 1.8, 'The wall is the reason this nearby drop is rejected');
  assert.equal(Weapons.findNearestPickup(), null);
  pressE(Weapons);
  assert.deepEqual(snapshot(Weapons), { current: 'fists', loaded: 0, reserve: 0 });
  assert.equal(WeaponDrops.list.includes(drop), true);
  assert.equal(calls.pickups, 0);

  Player.pos.z = -0.7;
  assert.equal(Weapons.findNearestPickup(), drop, 'Walking around the wall restores the same drop as a valid interaction');
  PlayerState.dead = true;
  pressE(Weapons);
  assert.equal(Weapons.pickup(drop), false);
  assert.equal(WeaponDrops.list.includes(drop), true);
  assert.equal(cache.remainingUnits, config.units);
  assert.equal(calls.pickups, 0);
  PlayerState.dead = false;
  pressE(Weapons);
  assert.deepEqual(snapshot(Weapons), { current: 'pistol', loaded: 9, reserve: 0 });
  assert.equal(calls.pickups, 1);
});

test('restoring controller and cache snapshots together cannot stack repeated collections', () => {
  const { Weapons, WeaponDrops, supplies, cache, calls } = fixture();
  // This checks the cooperating controller/ledger APIs, not mission triggers.
  const initial = { weapon: snapshot(Weapons), supplies: supplies.snapshot() };
  for (let life = 0; life < 4; life++) {
    pressE(Weapons);
    assert.deepEqual(snapshot(Weapons), { current: 'pistol', loaded: 3, reserve: 26 });
    assert.equal(cache.remainingUnits, 0);
    Weapons.dropCurrent();
    assert.equal(WeaponDrops.list.length, 1);
    WeaponDrops.clearAll();
    Weapons.restore(initial.weapon);
    assert.equal(supplies.restore(initial.supplies), true);
    assert.deepEqual(snapshot(Weapons), initial.weapon);
    assert.equal(cache.remainingUnits, config.units);
    assert.equal(WeaponDrops.list.length, 0);
  }
  pressE(Weapons);
  const later = { weapon: snapshot(Weapons), supplies: supplies.snapshot() };
  Weapons.loaded = 0; Weapons.reserve = 0;
  Weapons.restore(later.weapon);
  assert.equal(supplies.restore(later.supplies), true);
  supplies.setZone('stairwell');
  const pickups = calls.pickups;
  pressE(Weapons);
  assert.deepEqual(snapshot(Weapons), later.weapon);
  assert.equal(cache.remainingUnits, 0);
  assert.equal(calls.pickups, pickups, 'A later checkpoint includes the spent cache');
});

test('real E input collects three independent floor boxes one at a time without equipping or reloading', () => {
  const { Weapons, WeaponDrops, Player, supplies, calls } = fixture({ current: 'smg', loaded: 5, reserve: 0 }, AMMO_SUPPLY_CACHES);
  for (const [index, cacheConfig] of AMMO_SUPPLY_CACHES.entries()) {
    const entry = supplies.list.find(cache => cache.id === cacheConfig.id);
    supplies.setZone(cacheConfig.zone);
    Player.pos.set(cacheConfig.approach.x, cacheConfig.floorY + Player._eyeH, cacheConfig.approach.z);
    assert.equal(Weapons.findNearestPickup(), entry);
    pressE(Weapons);
    assert.deepEqual(snapshot(Weapons), { current: 'smg', loaded: 5, reserve: (index + 1) * AMMO_SUPPLY_LOADS.smg });
    assert.equal(Weapons.reloading, 0);
    assert.equal(calls.pickups, index + 1);
    assert.equal(WeaponDrops.list.length, 0);
    assert.deepEqual(supplies.list.map(cache => cache.remainingUnits), AMMO_SUPPLY_CACHES.map((_, i) => i <= index ? 0 : 120));
    pressE(Weapons);
    assert.equal(calls.pickups, index + 1, 'A second E press cannot replenish the same case');
  }
  assert.ok(supplies.list.every(cache => cache.mesh.visible && Colliders.list.includes(cache.collider)));
});

test('a rooftop checkpoint restores the weapon and all floor-box budgets without refilling earlier boxes', () => {
  const { Weapons, Player, supplies, calls } = fixture({ current: 'pistol', loaded: 3, reserve: 47 }, AMMO_SUPPLY_CACHES);
  pressE(Weapons);
  const checkpoint = { weapon: snapshot(Weapons), supplies: supplies.snapshot() };
  assert.deepEqual(checkpoint.supplies.caches.map(cache => cache.remainingUnits), [115, 120, 120]);

  // A disclosed fixture weapon swap exercises both rooftop stores. Restoring
  // the checkpoint must roll this equipment and all three inventories back.
  Weapons.restore({ current: 'smg', loaded: 5, reserve: 0 });
  supplies.setZone('roof');
  for (const cache of AMMO_SUPPLY_CACHES.slice(1)) {
    Player.pos.set(cache.approach.x, cache.floorY + Player._eyeH, cache.approach.z);
    pressE(Weapons);
  }
  assert.deepEqual(supplies.list.map(cache => cache.remainingUnits), [115, 0, 0]);
  Weapons.restore(checkpoint.weapon);
  assert.equal(supplies.restore(checkpoint.supplies), true);
  assert.deepEqual(snapshot(Weapons), { current: 'pistol', loaded: 3, reserve: 48 });
  assert.deepEqual(supplies.list.map(cache => cache.remainingUnits), [115, 120, 120]);
  const pickups = calls.pickups;
  pressE(Weapons);
  assert.equal(calls.pickups, pickups, 'A full restored reserve cannot consume the untouched rooftop box');

  supplies.setZone('balcony');
  Player.pos.set(config.approach.x, config.floorY + Player._eyeH, config.approach.z);
  pressE(Weapons);
  assert.equal(supplies.list[0].remainingUnits, 115, 'Revisiting the balcony retains its partial stock');
  supplies.reset();
  Weapons.restore({ current: 'fists', loaded: 0, reserve: 0 });
  assert.deepEqual(supplies.list.map(cache => cache.remainingUnits), [120, 120, 120]);
  assert.deepEqual(snapshot(Weapons), { current: 'fists', loaded: 0, reserve: 0 });
});
