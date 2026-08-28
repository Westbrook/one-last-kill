import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Colliders } from '../../src/core/collision.js';
import { getViewModelMuzzle } from '../../src/render/viewmodel.js';
import { createEnemyAIHarness } from './helpers/enemy-ai-harness.js';
import { weaponHarness } from './helpers/weapon-harness.js';

const ai = createEnemyAIHarness();
const weapon = weaponHarness({ ballistics: ai.ballistics, colliders: Colliders, damageEnemy: ai.damageEnemy });
weapon.ray.query = (...args) => ai.raycastEnemies(...args);
weapon.Weapons.init();
weapon.Weapons.restore({ current: 'pistol', loaded: 12, reserve: 0 });
const authoredMuzzle = [...weapon.Weapons._vm('pistol').userData.muzzle];

const vector = point => new THREE.Vector3(...point);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `${label}: ${actual} != ${expected}`);

function clearWeaponCalls() {
  for (const value of Object.values(weapon.calls)) if (Array.isArray(value)) value.length = 0;
}

function prepareShot(origin, feet, { type = 'gunman', alignedBarrel = true, zone = 'neighbor' } = {}) {
  ai.reset();
  const enemy = ai.spawn(type, { x: feet[0], y: feet[1], z: feet[2] }, { zone });
  weapon.Weapons.restore({ current: 'pistol', loaded: 12, reserve: 0 });
  const model = weapon.Weapons._vm('pistol');
  // Low, precisely aligned furniture probes isolate cover from view-model
  // parallax. They do not claim a standing camera or a rendered animation.
  // Dedicated tests below retain the actual authored barrel and pose.
  if (alignedBarrel) delete model.userData.muzzle;
  else model.userData.muzzle = [...authoredMuzzle];
  weapon.camera.position.fromArray(origin);
  weapon.camera.lookAt(feet[0], origin[1], feet[2]);
  weapon.Player.pos.copy(weapon.camera.position);
  weapon.Player.pitch = weapon.Player.yaw = 0;
  weapon.Player.aiming = false;
  weapon.Weapons.update(0);
  weapon.camera.updateMatrixWorld(true);
  clearWeaponCalls();
  return enemy;
}

function assertStopped(enemy, axis, coordinate, surfaceKind, expectedObject = null) {
  const health = enemy.health;
  assert.equal(weapon.Weapons._fireRanged(), false, 'actual weapon reports no enemy contact');
  assert.equal(enemy.health, health, 'actual enemy health is unchanged behind cover');
  assert.equal(weapon.calls.damage.length, 0, 'damage is not dispatched through cover');
  assert.equal(weapon.calls.shots.length, 1);
  assert.equal(weapon.calls.shots[0], false);
  assert.equal(weapon.Weapons.loaded, 11, 'blocked shots still consume a round');
  assert.equal(weapon.calls.impacts.length, 1, 'one physical surface receives the impact');
  assert.equal(weapon.calls.tracers.length, 1);
  const impact = weapon.calls.impacts[0], tracer = weapon.calls.tracers[0];
  near(impact.point[axis], coordinate, 'impact occurs at the nearby surface, not a distant wall');
  if (surfaceKind) assert.equal(impact.surfaceKind, surfaceKind);
  if (expectedObject) assert.equal(impact.object, expectedObject);
  near(impact.normal.length(), 1, 'surface normal is retained by the weapon effects');
  assert.ok(tracer.end.distanceTo(impact.point) < 1e-6, 'tracer ends exactly at the reported impact');
  return impact;
}

function assertPlayerHit(enemy) {
  const health = enemy.health;
  assert.equal(weapon.Weapons._fireRanged(), true);
  assert.ok(enemy.health < health, 'actual damageEnemy updates the real target');
  assert.equal(weapon.calls.damage.length, 1);
  assert.equal(weapon.calls.shots.length, 1);
  assert.equal(weapon.calls.shots[0], true);
  assert.equal(weapon.calls.impacts.length, 0, 'an open path produces no phantom world impact');
  assert.equal(weapon.calls.tracers.length, 1);
}

const furnitureCases = [
  { name: 'CRT front', origin: [7.05, 5.105, -8.1], feet: [7.05, 4, -5.9], axis: 'z', surface: -7.28 },
  { name: 'television rear case', origin: [7.05, 5.105, -5.9], feet: [7.05, 4, -8.1], axis: 'z', surface: -6.74, kind: 'metal' },
  { name: 'chair back', origin: [1.15, 4.82, -5], feet: [5.5, 4, -5], axis: 'x', surface: 1.485, kind: 'wood' },
  { name: 'chair seat', origin: [1.7, 4.415, -6.3], feet: [1.7, 4, -3.9], axis: 'z', surface: -5.2, kind: 'wood' },
  { name: 'chair leg', origin: [1.55, 4.195, -6.3], feet: [1.55, 4, -3.9], axis: 'z', surface: -5.1775, kind: 'wood' },
  { name: 'apartment wall', origin: [-4.4, 5.2, -8.8], feet: [-1.7, 4, -8.8], axis: 'x', surface: -3.1, kind: 'plaster' },
];

for (const scenario of furnitureCases) {
  test(`actual player firing cannot damage a target through the ${scenario.name}`, () => {
    const enemy = prepareShot(scenario.origin, scenario.feet);
    assertStopped(enemy, scenario.axis, scenario.surface, scenario.kind);
  });
}

test('actual player firing damages a target through the open space between chair legs', () => {
  const enemy = prepareShot([1.7, 4.195, -6.3], [1.7, 4, -3.9]);
  assertPlayerHit(enemy);
  assert.equal(enemy.health, 26, 'one pistol body hit applies its actual 24 damage');
  near(weapon.calls.tracers[0].end.z, -4.25, 'tracer reaches the enemy body before the far wall');
});

test('actual player firing distinguishes an inclined stair rail from its open AABB corner', () => {
  const rail = ai.fixture.records.get('stair-flight-1-central-guard').mesh;
  let enemy = prepareShot([-18.8, 5.825714285714286, -5], [-17.3, 4, -5], { type: 'enforcer', zone: 'stairwell' });
  assertStopped(enemy, 'x', -18.2675, 'metal', rail);
  enemy = prepareShot([-18.8, 5.9, -5], [-17.3, 4, -5], { type: 'enforcer', zone: 'stairwell' });
  assertPlayerHit(enemy);
  near(weapon.calls.tracers[0].end.x, -17.545, 'the unobstructed ray reaches the real head bounds');
});

function solidPanel(position, dimensions, { glass = false } = {}) {
  const material = new THREE.MeshStandardMaterial({ transparent: glass, opacity: glass ? 0.4 : 1 });
  material.userData.surfaceKind = glass ? 'glass' : 'metal';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), material);
  mesh.position.fromArray(position);
  return mesh;
}

function withObstacle(mesh, run) {
  ai.fixture.World.add(mesh);
  ai.ballistics.addObject(mesh);
  try { return run(mesh); }
  finally {
    ai.ballistics.removeObject(mesh);
    ai.fixture.World.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.map?.dispose();
    mesh.material.dispose();
  }
}

function balconyGunman(z = 0.95) {
  ai.reset({ x: 4, y: 4, z });
  return ai.spawn('gunman', { x: 0, y: 4, z }, { zone: 'balcony' });
}

function assertNPCShot(enemy, connects) {
  const before = ai.damage.length;
  assert.equal(ai.enemyAttackPlayer(enemy), connects, 'actual enemy firing returns the physical result');
  assert.equal(ai.damage.length - before, connects ? 1 : 0, 'player damage is dispatched only on a clear hit');
  if (connects) assert.equal(ai.damage.at(-1).attacker, enemy);
}

test('actual NPC perception and firing both respect the apartment wall', () => {
  ai.reset({ x: -1.7, y: 4, z: -8.8 });
  const enemy = ai.spawn('gunman', { x: -4.4, y: 4, z: -8.8 }, { zone: 'neighbor' });
  assert.equal(ai.hasLineOfSight(enemy), false);
  assertNPCShot(enemy, false);
});

test('an NPC rechecks newly registered solid cover even while its sight cache still says clear', () => {
  const enemy = balconyGunman();
  assert.equal(ai.hasLineOfSight(enemy), true);
  assertNPCShot(enemy, true);
  // This added test panel isolates cache and attack behavior on the real,
  // otherwise clear balcony. It is not a new authored level obstacle.
  withObstacle(solidPanel([2, 5, 0.95], [0.04, 2, 1.2]), () => {
    assert.equal(ai.hasLineOfSight(enemy), true, 'perception retains its normal throttled sample');
    assertNPCShot(enemy, false);
    ai.clock.elapsed += 0.2;
    assert.equal(ai.hasLineOfSight(enemy), false);
  });
  assertNPCShot(enemy, true);
});

test('NPCs see through a glass fixture but cannot damage the player through its solid pane', () => {
  const enemy = balconyGunman();
  withObstacle(solidPanel([2, 5, 0.95], [0.04, 2, 1.2], { glass: true }), () => {
    assert.equal(ai.hasLineOfSight(enemy), true, 'transparent glass permits perception');
    assertNPCShot(enemy, false);
  });
  assertNPCShot(enemy, true);
});

test('actual NPC perception and firing pass through a mask opening and stop on its visible strip', () => {
  const pixels = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 255]);
  const texture = new THREE.DataTexture(pixels, 4, 1);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  const material = new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide });
  material.userData.surfaceKind = 'metal';
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 2), material);
  panel.rotation.y = Math.PI / 2;
  panel.position.set(2, 5, 0.95);
  // A controlled mask fixture lets both actors remain at the real balcony
  // floor height. Authored diamond UVs and frames are tested separately in
  // world-ballistics.test.js; this case exercises the actual NPC controller.
  const enemy = balconyGunman();
  withObstacle(panel, () => {
    assert.equal(ai.hasLineOfSight(enemy), true);
    assertNPCShot(enemy, true);
    enemy.pos.z = enemy.mesh.position.z = 1.35;
    ai.placePlayer({ x: 4, y: 4, z: 1.35 });
    ai.clock.elapsed += 0.2;
    assert.equal(ai.hasLineOfSight(enemy), false, 'the opaque vertical strip blocks the sight ray');
    assertNPCShot(enemy, false);
  });
});

for (const anchored of [false, true]) {
  test(`an NPC ${anchored ? 'rig muzzle' : 'fallback barrel'} cannot start a round beyond nearby shoulder cover`, () => {
    const enemy = balconyGunman();
    const shoulder = new THREE.Vector3(enemy.pos.x, enemy.pos.y + enemy.height - 0.32, enemy.pos.z);
    const muzzle = shoulder.clone().add(new THREE.Vector3(anchored ? 0.65 : 0.45, 0, 0));
    let anchor;
    if (anchored) {
      // A real Object3D transform tests the weaponMuzzle branch without
      // pretending this CPU harness renders or animates the humanoid rig.
      anchor = new THREE.Object3D();
      enemy.mesh.rotation.set(0, 0, 0);
      anchor.position.set(0.65, enemy.height - 0.32, 0);
      enemy.mesh.add(anchor);
      enemy.mesh.userData.rig = { anchors: { weaponMuzzle: anchor } };
      enemy.mesh.updateMatrixWorld(true);
    }
    try {
      withObstacle(solidPanel([0.25, shoulder.y, 0.95], [0.04, 0.08, 0.3]), () => {
        assert.equal(ai.hasLineOfSight(enemy), true, 'the eye sees over the small obstruction');
        assert.equal(ai.ballistics.segmentOccluded(shoulder, muzzle, 'bullet'), true);
        const target = ai.player.pos.clone(); target.y -= 0.3;
        assert.equal(ai.ballistics.segmentOccluded(muzzle, target, 'bullet'), false,
          'a query starting only at the protruding muzzle would wrongly hit the player');
        assertNPCShot(enemy, false);
      });
      assertNPCShot(enemy, true);
    } finally {
      if (anchor) enemy.mesh.remove(anchor);
      delete enemy.mesh.userData.rig;
    }
  });
}

test('the actual held pistol cannot fire from a barrel protruding through nearby cover', () => {
  const enemy = prepareShot([0, 5.6, 0.95], [4, 4, 0.95], { alignedBarrel: false, zone: 'balcony' });
  const muzzle = getViewModelMuzzle(weapon.Weapons._vm('pistol'), new THREE.Vector3());
  assert.ok(muzzle && muzzle.x > 0.32, 'the authored barrel extends beyond the test panel');
  withObstacle(solidPanel([0.3, 5.55, 0.95], [0.04, 0.4, 0.8]), panel => {
    assertStopped(enemy, 'x', 0.28, 'metal', panel);
    assert.ok(weapon.calls.tracers[0].start.equals(weapon.camera.position),
      'a blocked barrel trace starts on the shooter side of cover');
  });
});

test('a clear crosshair cannot bypass cover intersecting the actual muzzle-to-target path', () => {
  const enemy = prepareShot([0, 5.6, 0.95], [4, 4, 0.95], { alignedBarrel: false, zone: 'balcony' });
  const muzzle = getViewModelMuzzle(weapon.Weapons._vm('pistol'), new THREE.Vector3());
  withObstacle(solidPanel([1, 5.5, 1.1], [0.04, 0.4, 0.1]), panel => {
    assert.equal(ai.ballistics.segmentOccluded(weapon.camera.position, vector([4, 5.6, 0.95]), 'bullet'), false,
      'the camera aim ray is unobstructed');
    assert.equal(ai.ballistics.segmentOccluded(weapon.camera.position, muzzle, 'bullet'), false,
      'the gun itself does not cross cover');
    assert.equal(ai.ballistics.segmentOccluded(muzzle, vector([3.755, 5.6, 0.95]), 'bullet'), true,
      'the real offset barrel has a blocked path to the target');
    assertStopped(enemy, 'x', 0.98, 'metal', panel);
    assert.ok(weapon.calls.tracers[0].start.distanceTo(muzzle) < 1e-6);
  });
});
