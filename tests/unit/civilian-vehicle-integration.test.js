import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DISTRICT } from '../../src/world/district-layout.js';
import { FINAL_ENCOUNTERS, ZONE_WAVE_CONFIG } from '../../src/game/mission-data.js';
import { capsuleHasClearance } from '../../src/core/collision.js';
import { createBallisticHit, createBallisticWorld } from '../../src/core/ballistics.js';
import { isSegmentOccluded } from '../../src/game/combat-rules.js';
import { createCivilianVehicle } from '../../src/render/civilian-vehicles.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

// This fixture executes the actual street/bakery builders and their real car
// geometry/material caches. It does not replace wheels with test boxes, create
// a renderer or play audio. Rendering quality remains a separate browser review.
const fixture = buildWorldSurfaceFixture();
const vehicles = fixture.World.children.filter(object => object.userData.civilianVehicle);
const objective = fixture.World.getObjectByName('gnucci-sedan');
const road = fixture.records.get('street-road');
fixture.ballistics.rebuild(fixture.World);

const near = (actual, expected, label, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${label}: ${actual} differs from ${expected}`);
const info = vehicle => vehicle.userData.civilianVehicle;
const meshes = vehicle => vehicle.children.filter(object => object.isMesh);
const localPoint = (vehicle, point) => new THREE.Vector3(...point).applyMatrix4(vehicle.matrixWorld);
const own = (vehicle, object) => {
  for (let parent = object; parent; parent = parent.parent) if (parent === vehicle) return true;
  return false;
};

function actualPartSurface(vehicle, name) {
  const bounds = new THREE.Box3(), point = new THREE.Vector3(), bottom = new THREE.Vector3(0, Infinity, 0);
  let vertices = 0;
  for (const mesh of meshes(vehicle)) {
    for (const part of mesh.geometry.userData.civilianParts || []) {
      if (part.name !== name) continue;
      const position = mesh.geometry.attributes.position;
      for (let vertex = part.vertexStart; vertex < part.vertexStart + part.vertexCount; vertex++) {
        point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld);
        bounds.expandByPoint(point);
        if (point.y < bottom.y) bottom.copy(point);
        vertices++;
      }
    }
  }
  assert.ok(vertices > 10 && !bounds.isEmpty(), `${name}: sample the actual merged surface`);
  return { bounds, bottom };
}

test('four civilian vehicles use distinct abandoned angles and preserve the separate objective', () => {
  assert.equal(vehicles.length, 4);
  assert.deepEqual(vehicles.map(vehicle => info(vehicle).profile.variant).sort(), ['hatchback', 'panel-van', 'sedan', 'wagon']);
  const van = vehicles.find(vehicle => info(vehicle).profile.variant === 'panel-van');
  assert.ok(van.position.z < 12, 'The taller van stays behind the opening street sightlines');
  assert.ok(objective && !objective.userData.civilianVehicle, 'The objective keeps its separate idling sedan');
  for (const axis of ['x', 'y', 'z']) {
    near(objective.position[axis], DISTRICT.car[axis], `Actual objective ${axis}`);
  }
  near(DISTRICT.car.yaw, Math.PI, 'Objective heading');
  near(objective.rotation.y, Math.PI, 'Actual objective heading');
  near(DISTRICT.car.length, 4.6, 'Objective length'); near(DISTRICT.car.width, 1.9, 'Objective width');
  assert.ok(capsuleHasClearance(new THREE.Vector3(DISTRICT.car.approach.x, DISTRICT.car.approach.y + 0.02,
    DISTRICT.car.approach.z), 0.32, 1.84, fixture.colliders), 'The relocated objective approach stays walkable');
  for (const vehicle of vehicles) {
    const placement = DISTRICT.street.parkedCars.find(parked => parked.id === info(vehicle).id);
    near(vehicle.position.x, placement.x, `${vehicle.name}: authored x`);
    near(vehicle.position.z, placement.z, `${vehicle.name}: authored z`);
    assert.ok(Math.abs(Math.sin(vehicle.rotation.y)) > 0.15, `${vehicle.name}: visibly skewed from the curb`);
    if (!placement.curb) near(vehicle.position.y, road.bounds.max.y, `${vehicle.name}: road anchor`);
    assert.ok(meshes(vehicle).length > 0 && meshes(vehicle).length <= 8, 'Keep bounded material batches per civilian vehicle');
    assert.ok(vehicle.children.every(object => object.isMesh), 'Civilian cars introduce no live lights or per-part scene nodes');
  }
});

test('every actual tire contacts its real road or apron triangle without intersecting the curb', () => {
  const apron = fixture.records.get('near-apron');
  let raisedWheels = 0;
  for (const vehicle of vehicles) {
    const { profile } = info(vehicle);
    assert.equal(profile.wheels.length, 4);
    for (const wheel of profile.wheels) {
      const { bounds, bottom } = actualPartSurface(vehicle, wheel.surfaceName || `tire:${wheel.name}`);
      const surface = bottom.z < road.bounds.min.z ? apron : road;
      if (surface === apron) raisedWheels++;
      assert.ok(bounds.min.x >= surface.bounds.min.x && bounds.max.x <= surface.bounds.max.x);
      assert.ok(bounds.min.z > surface.bounds.min.z + 0.075 && bounds.max.z < surface.bounds.max.z - 0.075,
        `${vehicle.name}/${wheel.name}: the entire tire clears the curb lip on its own surface`);
      const supportRay = new THREE.Raycaster(bottom.clone().add(new THREE.Vector3(0, 0.1, 0)), new THREE.Vector3(0, -1, 0), 0, 0.2);
      const support = supportRay.intersectObject(surface.mesh, false)[0];
      assert.ok(support, `${vehicle.name}/${wheel.name}: a real pavement triangle supports the lowest tire vertex`);
      near(support.point.y, bottom.y, `${vehicle.name}/${wheel.name}: tire/pavement contact`, 1e-5);
    }
  }
  assert.equal(raisedWheels, 2, 'One abandoned car rests with a full side on the raised pavement');
  const curbCar = vehicles.find(vehicle => info(vehicle).id === 'east');
  assert.ok(curbCar.rotation.x > 0.04 && curbCar.position.y > road.bounds.max.y,
    'The whole curb car tilts and rises with its supported tires');
});

test('the final car envelopes and registered movement bounds agree with their actual surfaces', () => {
  for (const vehicle of vehicles) {
    const { profile, visualBounds, worldBounds } = info(vehicle), colliders = vehicle.userData.movementColliders;
    assert.equal(colliders.length, 2, 'Each car registers only its lower body and variant cabin boxes');
    assert.ok(colliders.every(box => fixture.colliders.includes(box)), 'Review metadata points to actual registered collision');
    assert.ok(visualBounds?.isBox3, 'The asset exposes its measured local visual envelope');
    const actual = new THREE.Box3().setFromObject(vehicle, true), declared = visualBounds.clone().applyMatrix4(vehicle.matrixWorld);
    assert.ok(declared.clone().expandByScalar(1e-6).containsBox(actual), 'The transformed local envelope contains every rotated surface');
    for (const side of ['min', 'max']) for (const axis of ['x', 'y', 'z']) near(actual[side][axis], worldBounds[side][axis], `${vehicle.name}: measured ${side}.${axis}`);
    const union = colliders.reduce((box, collider) => box.union(collider), new THREE.Box3());
    assert.ok(actual.min.x >= union.min.x - 0.12 && actual.max.x <= union.max.x + 0.12
      && actual.min.z >= union.min.z - 0.12 && actual.max.z <= union.max.z + 0.12,
    `${vehicle.name}: body, wheels and mirrors stay within a small visible margin of physical cover`);
    // The upper box must cover the variant's actual roof footprint. A wagon
    // cannot reuse the sedan's shorter upper collision box under its rear roof.
    const cabin = profile.cabin;
    for (const x of [cabin.topRearX, cabin.topFrontX]) for (const z of [-cabin.topHalfWidth, cabin.topHalfWidth]) {
      const point = localPoint(vehicle, [x, cabin.roofTopY - 0.01, z]);
      assert.ok(colliders.some(box => box.clone().expandByScalar(0.02).containsPoint(point)),
        `${vehicle.name}: roof corner has matching solid movement cover`);
    }
  }
});

test('relocated cars clear full arrival jitter, checkpoint approaches and the bakery crossing', () => {
  const carBounds = vehicles.flatMap(vehicle => vehicle.userData.movementColliders);
  for (const [label, config] of [['street', ZONE_WAVE_CONFIG.street], ['finale', FINAL_ENCOUNTERS.car]]) {
    for (const point of config.spawns) {
      // These are the runtime director's conservative radius/height, including
      // the full rectangular variation range rather than only its centre.
      const envelope = new THREE.Box3(
        new THREE.Vector3(point.x - config.variation.jitterX - 0.48, point.y + 0.02, point.z - config.variation.jitterZ - 0.48),
        new THREE.Vector3(point.x + config.variation.jitterX + 0.48, point.y + 2.02, point.z + config.variation.jitterZ + 0.48),
      );
      assert.ok(carBounds.every(box => !box.intersectsBox(envelope)), `${label}: complete arrival space at ${point.x},${point.z}`);
    }
  }
  const points = [DISTRICT.street.checkpoint, DISTRICT.car.approach, DISTRICT.street.qa.firstGun,
    ...DISTRICT.street.qa.benchmark, DISTRICT.street.qa.wallShot, ...DISTRICT.bakery.accessRoute];
  for (const point of points) assert.ok(capsuleHasClearance(new THREE.Vector3(point.x, point.y + 0.02, point.z), 0.48, 2.02, fixture.colliders),
    `Reserved arrival point ${point.x},${point.z} remains clear`);
  for (let z = 8.5; z <= 27.5; z += 0.1) assert.ok(capsuleHasClearance(new THREE.Vector3(-18.75, z < 25 ? 0.07 : 0.16, z), 0.32, 1.84, carBounds),
    `Bakery crossing remains clear at z=${z}`);
  for (let x = -35; x <= 35; x += 0.2) assert.ok(capsuleHasClearance(new THREE.Vector3(x, 0.07, 18.7), 0.32, 1.84, carBounds),
    `Shared road approach remains clear at x=${x}`);
});

function checkProjectileSurface(vehicle, localOrigin, localTarget, ballistics = fixture.ballistics) {
  const origin = localPoint(vehicle, localOrigin), target = localPoint(vehicle, localTarget);
  const distance = origin.distanceTo(target), direction = target.clone().sub(origin).normalize();
  const visible = new THREE.Raycaster(origin, direction, 0, distance).intersectObject(vehicle, true)[0];
  const hit = ballistics.raycast(origin, direction, distance, 'bullet', createBallisticHit());
  assert.ok(visible && hit && own(vehicle, hit.object), `${vehicle.name}: visible cover catches the projectile`);
  near(hit.distance, visible.distance, `${vehicle.name}: nearest rendered hit`, 2e-5);
  assert.ok(hit.point.distanceTo(visible.point) <= 2e-5, 'Impact reaches the real visible surface');
  return hit;
}

function glazingProbe(vehicle, region, ballistics) {
  const point = new THREE.Vector3(...region.probe), inward = new THREE.Vector3(...region.inwardDirection).normalize();
  const outside = point.clone().addScaledVector(inward, -0.35), inside = point.clone().addScaledVector(inward, 0.04);
  const hit = checkProjectileSurface(vehicle, outside.toArray(), inside.toArray(), ballistics);
  assert.equal(hit.surfaceKind, 'glass', `${vehicle.name}/${region.partName}: probe reaches the actual pane`);
  const start = localPoint(vehicle, outside.toArray()), end = localPoint(vehicle, inside.toArray());
  assert.equal(ballistics.segmentOccluded(start, end, 'bullet'), true, 'The pane catches bullets');
  assert.equal(ballistics.segmentOccluded(start, end, 'sight'), false, 'The same pane transmits sight without a hidden opaque backing');
  return hit;
}

test('projectiles use actual car bodies and glazing while the open underbody stays open', () => {
  for (const vehicle of vehicles) {
    const { profile } = info(vehicle), outside = profile.width / 2 + 0.7;
    for (const side of [-1, 1]) checkProjectileSurface(vehicle, [0, 0.55, side * outside], [0, 0.55, 0]);
    const cabin = profile.cabin, windowY = (cabin.beltY + cabin.glassTopY) / 2;
    let glassProbes = 0;
    if (profile.glazingRegions) {
      for (const region of profile.glazingRegions) {
        glazingProbe(vehicle, region, fixture.ballistics); glassProbes++;
      }
    } else for (const t of [0.25, 0.4, 0.6, 0.75]) {
      const x = cabin.topRearX + (cabin.topFrontX - cabin.topRearX) * t;
      const hit = checkProjectileSurface(vehicle, [x, windowY, outside], [x, windowY, 0]);
      if (hit.surfaceKind === 'glass') glassProbes++;
    }
    assert.ok(glassProbes > 0, `${vehicle.name}: actual glass remains projectile cover`);
    const origin = localPoint(vehicle, [0, 0.12, -outside]), target = localPoint(vehicle, [0, 0.12, outside]);
    assert.ok(isSegmentOccluded(origin, target, vehicle.userData.movementColliders), 'The positive control crosses the generous movement body box');
    assert.equal(fixture.ballistics.segmentOccluded(origin, target, 'bullet'), false,
      `${vehicle.name}: movement envelope must not turn underbody air into projectile cover`);
  }
});

test('the taller middle van preserves direct street views of both objectives', () => {
  const camera = new THREE.Vector3(DISTRICT.street.checkpoint.x, DISTRICT.street.checkpoint.y + 1.72, DISTRICT.street.checkpoint.z);
  const doorway = new THREE.Vector3((DISTRICT.bakery.door.x1 + DISTRICT.bakery.door.x2) / 2, 1.75, DISTRICT.bakery.door.z - 0.4);
  for (const channel of ['bullet', 'sight']) assert.equal(fixture.ballistics.segmentOccluded(camera, doorway, channel), false,
    `The taller cargo body cannot obstruct the initial bakery doorway ${channel} ray`);
  const objectivePoint = objective.position.clone().add(new THREE.Vector3(0, 1.1, 0));
  const direction = objectivePoint.clone().sub(camera).normalize(), distance = camera.distanceTo(objectivePoint);
  const target = fixture.ballistics.raycast(camera, direction, distance, 'bullet', createBallisticHit());
  assert.ok(target && own(objective, target.object), 'The real objective is the first visible projectile surface on its direct approach ray');
  const sign = fixture.World.getObjectByName('bakery-shop-sign'), signPoint = sign.getWorldPosition(new THREE.Vector3());
  const signDirection = signPoint.clone().sub(camera).normalize();
  assert.equal(fixture.ballistics.raycast(camera, signDirection, camera.distanceTo(signPoint) - 0.05, 'sight'), null,
    'The actual bakery sign remains visible above the unchanged street approach');
});

test('van cargo and passenger windows use real opaque or glass bullet and sight surfaces', () => {
  for (const variant of ['panel-van', 'passenger-van']) {
    // Passenger is an available factory/QA option. Keep this independent asset
    // index out of the installed scene and its collision registry.
    const asset = createCivilianVehicle({ variant, paint: 0x647267, finish: 'used' });
    const installed = variant === 'panel-van' ? vehicles.find(vehicle => info(vehicle).profile.variant === variant) : null;
    const vehicle = installed || asset.group;
    vehicle.updateMatrixWorld(true);
    const ballistics = installed ? fixture.ballistics : createBallisticWorld();
    if (!installed) ballistics.rebuild(vehicle);
    const { profile } = asset, outside = profile.width / 2 + 0.5;
    assert.ok(profile.glazingRegions?.length >= 2, `${variant}: real cab glazing is described`);
    for (const region of profile.glazingRegions) glazingProbe(vehicle, region, ballistics);
    const [x, y] = profile.cargo.sideProbe;
    const start = localPoint(vehicle, [x, y, outside]), end = localPoint(vehicle, [x, y, -outside]);
    const hit = checkProjectileSurface(vehicle, [x, y, outside], [x, y, -outside], ballistics);
    assert.equal(ballistics.segmentOccluded(start, end, 'bullet'), true, `${variant}: cargo panel or glazing stops bullets`);
    assert.equal(ballistics.segmentOccluded(start, end, 'sight'), profile.cargo.opaque,
      `${variant}: complete cargo bay crossing follows its actual construction`);
    assert.equal(hit.surfaceKind === 'glass', !profile.cargo.opaque);
    if (profile.cargo.opaque) {
      const highStart = localPoint(vehicle, [x, 1.72, outside]), highEnd = localPoint(vehicle, [x, 1.72, -outside]);
      assert.equal(ballistics.segmentOccluded(highStart, highEnd, 'sight'), true, 'Tall cargo really blocks a standing eye ray');
      const collision = installed ? vehicle.userData.movementColliders : asset.movementBounds;
      const position = installed ? localPoint(vehicle, [x, 1.72, 0]) : new THREE.Vector3(x, 1.72, 0);
      assert.ok(collision.some(box => box.containsPoint(position)),
        'The same high cargo region is represented in movement collision');
    }
  }
});

test('all vehicle factory variants reuse cached geometry and materials while preserving independent transforms', () => {
  for (const variant of ['sedan', 'hatchback', 'wagon', 'panel-van', 'passenger-van']) {
    const options = { variant, paint: 0x647267, finish: 'used' };
    const first = createCivilianVehicle(options), second = createCivilianVehicle(options);
    const repainted = createCivilianVehicle({ ...options, paint: 0x766754, finish: 'kept' });
    assert.notEqual(first.group, second.group); assert.notEqual(first.group.matrix, second.group.matrix);
    assert.notEqual(first.movementBounds[0], second.movementBounds[0]);
    assert.notEqual(first.visualBounds, second.visualBounds);
    const a = meshes(first.group), b = meshes(second.group), c = meshes(repainted.group);
    assert.equal(a.length, b.length); assert.equal(a.length, c.length);
    for (let index = 0; index < a.length; index++) {
      assert.equal(a[index].geometry, b[index].geometry, `${variant}: identical instances share geometry`);
      assert.equal(a[index].material, b[index].material, `${variant}: identical finishes share materials`);
      assert.equal(a[index].geometry, c[index].geometry, `${variant}: paint never duplicates geometry`);
    }
  }
  for (const vehicle of vehicles) for (const mesh of meshes(vehicle)) {
    assert.ok(mesh.geometry.attributes.position.array.every(Number.isFinite));
    assert.ok(mesh.geometry.attributes.normal.array.every(Number.isFinite));
    assert.ok(mesh.material.isMeshStandardMaterial, 'Vehicles retain the established PBR lighting pipeline');
  }
});
