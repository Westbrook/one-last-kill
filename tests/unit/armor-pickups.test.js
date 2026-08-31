import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Group, Vector3 } from 'three';
import { ARMOR_DROP_LIMIT, createArmorPickups } from '../../src/game/armor-pickups.js';

function fixture() {
  const world = new Group();
  const player = { health: 80, armor: 0, pos: new Vector3(0, 15.72, 0), _eyeH: 1.72 };
  const gate = { active: true }, collected = [], colliders = [];
  const pickups = createArmorPickups();
  pickups.init({ world, player, colliders, canCollect: () => gate.active, onCollect: pickup => collected.push(pickup) });
  pickups.setZone('roof');
  return { world, player, gate, collected, colliders, pickups,
    spawn: (amount = 100, zone = 'roof') => pickups.spawn(0, 14, 0, amount, zone),
    step: () => pickups.update(1 / 120) };
}

test('walking over a vest equips its exact strength once without changing health or adding lights', () => {
  for (const amount of [100, 50]) {
    const h = fixture(), drop = h.spawn(amount);
    assert.equal(drop.mesh.position.y, 14.45);
    assert.equal(drop.mesh.parent, h.world);
    let lights = 0;
    h.world.traverse(object => { if (object.isLight) lights++; });
    assert.equal(lights, 0);
    h.step(); h.step();
    assert.equal(h.player.armor, amount);
    assert.equal(h.player.health, 80);
    assert.deepEqual(h.collected, [drop]);
    assert.equal(drop.active, false);
    assert.equal(drop.mesh.visible, false);
    assert.equal(drop.mesh.parent, null);
    assert.equal(h.pickups.list.length, 0);
  }
});

test('the strongest nearby vest wins, and equal or weaker vests remain available without stacking', () => {
  const h = fixture(), damaged = h.spawn(50), intact = h.spawn(100);
  h.step();
  assert.equal(h.player.armor, 100);
  assert.deepEqual(h.collected, [intact]);
  assert.equal(damaged.active, true);
  h.player.armor = 50; h.step();
  assert.equal(damaged.active, true);
  h.player.armor = 20; h.step();
  assert.equal(h.player.armor, 50);
  assert.deepEqual(h.collected, [intact, damaged]);
  const other = h.spawn(50); h.step();
  assert.equal(other.active, true);
  assert.equal(h.player.armor, 50);
});

test('zone changes, pause, death and invalid simulation steps cannot award armor', () => {
  const h = fixture(), drop = h.spawn();
  h.pickups.setZone('stairwell'); h.step();
  assert.equal(drop.mesh.visible, false);
  h.pickups.setZone('roof');
  assert.equal(drop.mesh.visible, true);
  h.gate.active = false;
  const position = drop.mesh.position.clone(), yaw = drop.mesh.rotation.y;
  h.step();
  assert.ok(drop.mesh.position.equals(position)); assert.equal(drop.mesh.rotation.y, yaw);
  h.gate.active = true; h.player.health = 0; h.step();
  h.player.health = 80;
  for (const dt of [0, -1, NaN, Infinity]) h.pickups.update(dt);
  assert.equal(drop.active, true); assert.equal(h.player.armor, 0);
  h.step();
  assert.equal(h.player.armor, 100);
});

test('collection respects distance, floors and solid cover while supporting crouched players', () => {
  const h = fixture(), drop = h.spawn();
  h.player.pos.x = 0.91; h.step(); assert.equal(drop.active, true);
  h.player.pos.set(0, 14.72, 0); h.step(); assert.equal(drop.active, true);
  h.player.pos.set(0.6, 15.72, 0);
  h.colliders.push(new Box3(new Vector3(0.2, 14, -1), new Vector3(0.4, 17, 1)));
  h.step(); assert.equal(drop.active, true, 'a vest cannot be collected through a wall');
  h.colliders.length = 0;
  h.player._eyeH = 1.1; h.player.pos.y = 15.1;
  h.step();
  assert.equal(h.player.armor, 100);
});

test('drop count and checkpoint cleanup release groups without disposing shared resources', () => {
  const h = fixture(), first = h.spawn();
  const resources = first.mesh.children.map(mesh => [mesh.geometry, mesh.material]);
  let disposed = 0;
  for (const pair of resources) for (const resource of pair) resource.addEventListener('dispose', () => disposed++);
  for (let index = 0; index < ARMOR_DROP_LIMIT; index++) h.spawn();
  assert.equal(h.pickups.list.length, ARMOR_DROP_LIMIT);
  assert.equal(h.world.children.length, ARMOR_DROP_LIMIT);
  assert.equal(first.mesh.parent, null); assert.equal(first.active, false);
  h.pickups.clearAll(); h.pickups.clearAll();
  assert.equal(h.world.children.length, 0); assert.equal(h.pickups.list.length, 0);
  assert.equal(h.player.armor, 0); assert.deepEqual(h.collected, []);
  const next = h.spawn();
  for (const [index, mesh] of next.mesh.children.entries()) {
    assert.equal(mesh.geometry, resources[index][0]); assert.equal(mesh.material, resources[index][1]);
  }
  assert.equal(disposed, 0);
});
