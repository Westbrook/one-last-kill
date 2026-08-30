import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHumanoidRig, attachHeldWeapon, resetHumanoidPose, updateHumanoidPose, getHumanoidVisualBounds,
} from '../../src/render/humanoid-rig.js';
import { beginHumanoidCollapse, updateHumanoidCollapse } from '../../src/render/corpse-pose.js';
import { BALCONY, ROOF } from '../../src/world/layout.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';

// Real production spawn/death/AI code, authored collider floors, and actual
// skinned character surfaces. Only browser rendering/audio/effects are absent.
const h = createEnemyAIHarness({ humanoids: {
  makeHumanoid: createHumanoidRig,
  attachHeldWeapon: (root, type) => attachHeldWeapon(root, type),
  resetHumanoidPose, updateHumanoidPose, beginHumanoidCollapse, updateHumanoidCollapse,
} });
const near = (actual, expected, tolerance = 1e-6) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`,
);

function spawnWithoutTick({ type, x, z, floor, zone, yaw = 0 }) {
  h.reset();
  const enemy = h.Enemies.spawn(type, x, z, floor + 0.02);
  assert.ok(enemy); enemy.zone = zone; enemy.yaw = yaw; enemy.mesh.rotation.y = yaw;
  const mode = enemy.def.attack === 'hitscan' ? 'ranged' : enemy.def.weaponType === 'bat' ? 'bat' : 'fist';
  updateHumanoidPose(enemy.mesh, { mode, alert: 1, aim: 1, swingProgress: 0.3 }, 0.1);
  near(enemy.floorY, floor + 0.02, 1e-8);
  near(h.clock.elapsed, 0);
  return enemy;
}

function settleOnActualFloor(enemy, floor) {
  for (let frame = 0; frame < 90; frame++) h.step(1 / 120);
  assert.equal(enemy.mesh.userData.rig.collapse.settled, true);
  const bounds = getHumanoidVisualBounds(enemy.mesh);
  assert.ok(bounds.min.y >= floor - 0.001 && bounds.min.y <= floor + 0.012,
    `${enemy.type} actual skin is ${(bounds.min.y - floor) * 1000}mm from its supporting collider`);
  return bounds;
}

test('immediate balcony deaths resolve spawn clearance before placing the actual corpse and dropped weapon', () => {
  for (const fixture of [
    { type: 'thug', x: -18.25, z: 0.56, yaw: -Math.PI / 2 },
    { type: 'brawler', x: 12.25, z: 1.30, yaw: Math.PI / 2 },
  ]) {
    const floor = BALCONY.floorY, enemy = spawnWithoutTick({ ...fixture, floor, zone: 'balcony' });
    assert.equal(h.killEnemy(enemy), true);
    near(enemy.floorY, floor); near(enemy.mesh.userData.rig.collapse.floorY, floor);
    // Death records the floor without moving the live capsule or skipping the
    // authored fall. Its next ordinary corpse update handles root placement.
    near(enemy.pos.y, floor + 0.02);
    const bounds = settleOnActualFloor(enemy, floor), wrap = BALCONY.wrap;
    assert.ok(bounds.min.x >= wrap.x1 + 0.085 && bounds.max.x <= wrap.x2 - 0.085);
    assert.ok(bounds.min.z >= wrap.z1 + 0.095 && bounds.max.z <= wrap.z2 - 0.085);
    const expectedDrops = enemy.def.weaponType === 'fists' ? 0 : 1;
    assert.equal(h.drops.length, expectedDrops);
    if (expectedDrops) near(h.drops[0][1], floor);
    assert.equal(h.killEnemy(enemy), false); assert.equal(h.drops.length, expectedDrops);
  }
});

test('lethal damage refreshes roof, road, apron and landing support without choosing a distant floor', () => {
  for (const fixture of [
    { type: 'bruiser', x: 22, z: -4, floor: ROOF.floorY, zone: 'roof' },
    { type: 'gunman', x: 18, z: 18, floor: DISTRICT.street.road.floorY, zone: 'street' },
    { type: 'enforcer', x: 0, z: 5, floor: DISTRICT.street.nearApron.floorY, zone: 'street' },
    { type: 'hitman', x: -19.45, z: -0.85, floor: 6.4, zone: 'stairwell' },
  ]) {
    const enemy = spawnWithoutTick(fixture);
    if (fixture.zone === 'roof') enemy.floorY = 0; // A stale lower landing cannot pull a roof corpse through its deck.
    const result = h.damageEnemy(enemy, enemy.def.maxHealth + 1, 'body');
    assert.equal(result.killed, true); assert.equal(enemy.alive, false);
    near(enemy.floorY, fixture.floor); near(enemy.mesh.userData.rig.collapse.floorY, fixture.floor);
    near(h.drops[0][1], fixture.floor);
    settleOnActualFloor(enemy, fixture.floor);
  }
});

test('an unsupported death retains its last known finite floor instead of inventing support', () => {
  const enemy = spawnWithoutTick({ type: 'thug', x: -10, z: -12.5, floor: ROOF.floorY, zone: 'roof' });
  assert.equal(h.surfaceTopAt(enemy.pos.x, enemy.pos.y + 0.20, enemy.pos.z, 2.5), -Infinity,
    'The authored roof lightwell has no support within the live movement window');
  enemy.floorY = ROOF.floorY;
  assert.equal(h.killEnemy(enemy), true);
  near(enemy.floorY, ROOF.floorY); near(enemy.mesh.userData.rig.collapse.floorY, ROOF.floorY);
  near(h.drops[0][1], ROOF.floorY);
  h.step(1 / 120);
  assert.ok(enemy.mesh.position.toArray().every(Number.isFinite));
});
