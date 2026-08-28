import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { placeWeaponDrop } from '../../src/game/drop-placement.js';
import { BAT_DIMENSIONS, createBatAsset } from '../../src/render/bat-asset.js';
import { weaponHarness } from './helpers/weapon-harness.js';

const box = (x1, x2, y1, y2, z1, z2) => new THREE.Box3(new THREE.Vector3(x1, y1, z1), new THREE.Vector3(x2, y2, z2));
const types = ['bat', 'knife', 'pistol', 'shotgun', 'smg', 'machinegun'];

test('all actual weapon pickups rest flat on the floor even when dropped during a jump', () => {
  const floor = box(-5, 5, 3.8, 4, -5, 5), { WeaponDrops } = weaponHarness();
  for (const type of types) for (const yaw of [0, 0.4, 1.2, 2.8]) {
    const mesh = WeaponDrops._build(type);
    const result = placeWeaponDrop(mesh, type, { x: 0, y: 4.65, z: 0 }, [floor], yaw);
    const bounds = new THREE.Box3().setFromObject(mesh);
    assert.equal(result.settled, true, type);
    assert.equal(result.floorY, 4);
    assert.ok(Math.abs(bounds.min.y - 4.006) < 1e-6, type);
    assert.ok(bounds.max.y - bounds.min.y < 0.09, `${type} should lie on its side, not balance on its stock or barrel`);
    assert.equal(bounds.intersectsBox(floor), false);
  }
});

test('the dropped bat uses the same unscaled asset as held bats', () => {
  const { WeaponDrops } = weaponHarness(), mesh = WeaponDrops._build('bat');
  const asset = mesh.getObjectByName('weapon:bat'), reference = createBatAsset();
  assert.equal(asset.userData.dimensions, BAT_DIMENSIONS);
  assert.equal(asset.getObjectByName('bat-wood').geometry, reference.getObjectByName('bat-wood').geometry);
  assert.deepEqual(asset.scale.toArray(), [1, 1, 1]);
  const floor = box(-4, 4, -0.2, 0, -4, 4);
  placeWeaponDrop(mesh, 'bat', { x: 0, y: 0, z: 0 }, [floor]);
  const length = asset.userData.anchors.tip.getWorldPosition(new THREE.Vector3())
    .distanceTo(asset.userData.anchors.knob.getWorldPosition(new THREE.Vector3()));
  assert.ok(Math.abs(length - 0.84) < 1e-6);
});

test('near a gallery wall or open edge, pickups turn to fit their actual supporting deck', () => {
  const floor = box(-3, 3, 3.8, 4, 0, 1.8), wall = box(-3, 3, 4, 7, -0.2, 0.1);
  const { WeaponDrops } = weaponHarness();
  for (const type of types) for (const z of [0.46, 1.43]) {
    const mesh = WeaponDrops._build(type);
    const placed = placeWeaponDrop(mesh, type, { x: 0, y: 4, z }, [floor, wall], Math.PI / 2);
    const bounds = new THREE.Box3().setFromObject(mesh);
    assert.equal(placed.settled, true, type);
    assert.equal(bounds.intersectsBox(wall), false, type);
    assert.ok(bounds.min.z >= 0.1 && bounds.max.z <= 1.8, type);
  }
});

test('stair pickups can settle across a tread without floating in the riser face', () => {
  const treads = Array.from({ length: 14 }, (_, index) => box(-1.2, 1.2, 3.8, 4 + (index + 1) * (2.4 / 14), index * 0.3, (index + 1) * 0.3));
  const { WeaponDrops } = weaponHarness();
  for (const type of types) for (const yaw of [0.13, 0.37, Math.PI / 2, 2.85]) for (let index = 1; index < 13; index += 3) {
    const mesh = WeaponDrops._build(type), y = treads[index].max.y;
    const placed = placeWeaponDrop(mesh, type, { x: 0.7, y, z: index * 0.3 + 0.03 }, treads, yaw);
    const bounds = new THREE.Box3().setFromObject(mesh);
    assert.equal(placed.settled, true, `${type}, tread ${index}, yaw ${yaw}`);
    assert.ok(treads.every(tread => !bounds.intersectsBox(tread)), `${type} intersects a stair`);
    assert.ok(Math.hypot(mesh.position.x - 0.7, mesh.position.z - (index * 0.3 + 0.03)) <= 0.201);
  }
});

test('unsupported geometry is not reported as a successfully grounded pickup', () => {
  const { WeaponDrops } = weaponHarness(), mesh = WeaponDrops._build('bat');
  assert.equal(placeWeaponDrop(mesh, 'bat', { x: 0, y: 4, z: 0 }, []).settled, false);
  assert.ok(new THREE.Box3().setFromObject(mesh).min.toArray().every(Number.isFinite));
});
