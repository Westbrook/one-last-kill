import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createCivilianVehicle } from '../../src/render/civilian-vehicles.js';
import { placeCivilianVehicle } from '../../src/render/parked-vehicle-placement.js';
import { buildStreetVehicleAftermath, scorchCivilianVehicle } from '../../src/render/street-vehicle-aftermath.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { Colliders } from '../../src/core/collision.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';

test('scorch changes only the wreck finish and leaves shared vehicle shape and materials intact', () => {
  const wreck = createCivilianVehicle().group, untouched = createCivilianVehicle().group;
  const paint = wreck.children.find(mesh => mesh.name.endsWith('-paint'));
  const shared = untouched.children.find(mesh => mesh.name.endsWith('-paint'));
  const positions = new Float32Array(shared.geometry.attributes.position.array);
  const colors = new Float32Array(shared.geometry.attributes.color.array);
  const roughness = shared.material.roughness;
  scorchCivilianVehicle(wreck);
  assert.notEqual(paint.geometry, shared.geometry);
  assert.notEqual(paint.material, shared.material);
  assert.deepEqual(paint.geometry.attributes.position.array, positions, 'Visible and ballistic surfaces do not move');
  assert.deepEqual(shared.geometry.attributes.color.array, colors, 'Another sedan does not inherit the burn');
  assert.equal(shared.material.roughness, roughness);
  const p = paint.geometry.attributes.position, c = paint.geometry.attributes.color;
  let darkened = 0, retained = 0;
  for (let index = 0; index < p.count; index++) {
    if (p.getX(index) > 1.7 && p.getY(index) > 0.65) {
      assert.ok(c.getX(index) < colors[index * 3] * 0.25); darkened++;
    }
    if (p.getX(index) < 0) { assert.equal(c.getX(index), colors[index * 3]); retained++; }
  }
  assert.ok(darkened > 30 && retained > 30, 'The hood is charred while the rear retains its paint');
  assert.equal(wreck.children.length, untouched.children.length, 'Scorch adds no draw calls');
});

function fixture() {
  Colliders.clear();
  const world = new THREE.Group(), WorldState = { fires: [], smokeSystems: [] };
  for (const placement of DISTRICT.street.parkedCars) {
    const vehicle = createCivilianVehicle({ variant: placement.variant, paint: placement.color, finish: placement.finish });
    const result = placeCivilianVehicle(vehicle, placement);
    vehicle.group.userData.civilianVehicle.id = placement.id;
    for (const bounds of result.movementBounds) {
      const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
      Colliders.addBoxBySize(center.x, center.y, center.z, size.x, size.y, size.z);
    }
    world.add(vehicle.group);
  }
  const source = readFileSync(new URL('../../src/world/world.js', import.meta.url), 'utf8')
    .match(/function spawnFire\([^]*?\n\}/)?.[0];
  assert.ok(source);
  const spawnFire = runInNewContext(`${source}\n;spawnFire;`, {
    THREE, Colliders, World: world, WorldState,
    makeFireMaterial: () => ({ mat: new THREE.MeshBasicMaterial(), phase: 0 }),
    makeSmokeSystem: () => ({ points: new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()) }),
    setFireActive() {},
  });
  return { world, WorldState, spawnFire };
}

test('one hood fire follows the angled sedan and preserves movement, projectile cover and light budgets', () => {
  const h = fixture(), ballistic = createBallisticWorld();
  h.world.updateMatrixWorld(true); ballistic.rebuild(h.world);
  const before = ballistic.snapshot(), collidersBefore = Colliders.list.length;
  const result = buildStreetVehicleAftermath({ world: h.world, district: DISTRICT, spawnFire: h.spawnFire });
  assert.equal(h.WorldState.fires.length, 1); assert.equal(h.WorldState.smokeSystems.length, 1);
  assert.equal(Colliders.list.length, collidersBefore, 'The body keeps its cover without an invisible fire barrier');
  assert.equal(result.fire.collider, null); assert.equal(result.fire.group.userData.ballistics, false);
  assert.ok(result.fire.group.position.distanceTo(new THREE.Vector3(1.5, 0.79, 0.02)
    .applyMatrix4(result.wreck.matrixWorld)) < 1e-8);
  assert.equal(result.fire.light.castShadow, false); assert.equal(result.fire.light.userData.zone, 'street');
  let lights = 0; h.world.traverse(object => { if (object.isLight) lights++; });
  assert.equal(lights, 1, 'The engine fire uses a single existing-budget practical source');
  h.world.updateMatrixWorld(true); ballistic.rebuild(h.world);
  assert.equal(ballistic.snapshot().objects, before.objects);
  assert.equal(ballistic.snapshot().triangles, before.triangles, 'Fire, smoke and paint cannot become bulletproof sheets');
  const bakery = DISTRICT.bakery.door;
  assert.ok(Math.hypot(result.fire.group.position.x - (bakery.x1 + bakery.x2) / 2,
    result.fire.group.position.z - bakery.z) > 12, 'Smoke remains away from the bakery entrance');
});

test('curved skid marks remain shallow supported paint across the road and curb', () => {
  const h = fixture();
  const { marks } = buildStreetVehicleAftermath({ world: h.world, district: DISTRICT, spawnFire: h.spawnFire });
  assert.equal(marks.userData.ballistics, false);
  assert.ok(marks.geometry.index.count / 3 <= 384, 'One bounded mesh draws all worn tracks');
  const positions = marks.geometry.attributes.position;
  const normals = marks.geometry.attributes.normal;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
    assert.ok(Number.isFinite(x + y + z));
    assert.ok(x > DISTRICT.bounds.x1 && x < DISTRICT.bounds.x2 && z > 0 && z < 28);
    assert.ok(Math.min(Math.abs(y - 0.053), Math.abs(y - 0.143)) < 1e-6, 'Paint rests on the supporting street surface');
    assert.ok(normals.getY(index) > 0.99, 'The single-sided tire marks must face the player above the road');
  }
});
