import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DISTRICT } from '../../src/world/district-layout.js';
import { BUILDING } from '../../src/world/layout.js';
import { FINAL_ENCOUNTERS, ZONE_WAVE_CONFIG } from '../../src/game/mission-data.js';
import { Architecture, boxBounds, signYaw } from '../../src/world/architecture.js';
import { Colliders, capsuleHasClearance } from '../../src/core/collision.js';
import { addBakeryBread, addBakeryPackage } from '../../src/render/bakery-provisions.js';
import { getBakeryProvisionMaterials } from '../../src/render/bakery-provision-materials.js';
import { refineConcreteBarrier } from '../../src/render/street-barrier.js';
import { createSedanCabin } from '../../src/render/sedan-cabin.js';
import { createSedanBumper, createSedanHood } from '../../src/render/sedan-panels.js';
import { createCivilianVehicle } from '../../src/render/civilian-vehicles.js';
import { buildStreetVehicleAftermath } from '../../src/render/street-vehicle-aftermath.js';
import { buildStreetAftermath } from '../../src/render/street-aftermath.js';
import { placeCivilianVehicle } from '../../src/render/parked-vehicle-placement.js';
import { buildClosedStorefront, getStorefrontMaterials, STOREFRONT_STYLES } from '../../src/render/storefront-kit.js';

// Real authored meshes and collision run without a renderer, browser or audio.
function buildFixture() {
  Architecture.clear();
  Colliders.clear();
  const World = new THREE.Group();
  const materials = new Map();
  const MATS = new Proxy({}, { get(_, key) {
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial());
    return materials.get(key);
  } });
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const _BG = { unitBox, pipe: new THREE.CylinderGeometry(1, 1, 1, 8) };
  const _CG = Object.fromEntries(['unitBox', 'wheel', 'hub', 'lug', 'spoke', 'wheelWell', 'headlight', 'headBezel', 'taillight', 'mirror', 'mirrorArm', 'antenna', 'grilleSlat', 'plate', 'doorHandle'].map((key) => [key, unitBox]));
  function addBox(x, y, z, width, height, depth, material, options = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    World.add(mesh);
    const collider = options.collide === false ? null : Colliders.addBoxBySize(x, y, z, width, height, depth);
    mesh.userData.collider = collider;
    if (options.architecture) Architecture.register(mesh, collider, boxBounds(x, y, z, width, height, depth), options.architecture);
    return mesh;
  }
  function pushDecor(geometry, material, x, y, z, width, height, depth, yaw = 0) {
    const mesh = new THREE.Mesh(geometry.clone(), material);
    mesh.position.set(x, y, z);
    mesh.scale.set(width, height, depth);
    mesh.rotation.y = yaw;
    World.add(mesh);
  }
  function addSign(x, y, z, width, height, normal) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), MATS.metal);
    mesh.position.set(x, y, z);
    mesh.rotation.y = signYaw(normal);
    World.add(mesh);
    return mesh;
  }
  const Triggers = { list: [], add(name, min, max) { this.list.push({ name, min, max }); } };
  const WorldState = { bakeryLights: [], smokeSystems: [], car: null };
  const source = readFileSync(new URL('../../src/world/zones/street.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export \{[^}]+\};\s*$/gm, '');
  assert.doesNotMatch(source, /^import\s/m);
  const builders = runInNewContext(source + '\n;({ buildStreet, buildBakeryAndCar });', {
    refineConcreteBarrier, buildClosedStorefront, getStorefrontMaterials, STOREFRONT_STYLES, createCivilianVehicle, placeCivilianVehicle,
    THREE, RoundedBoxGeometry, mergeGeometries, BUILDING, DISTRICT, MATS, World, WorldState, buildStreetVehicleAftermath, buildStreetAftermath,
    _BG, _CG, Colliders, addBox, pushDecor, addSign, Triggers, addBakeryBread, addBakeryPackage, getBakeryProvisionMaterials, createSedanCabin, createSedanBumper, createSedanHood,
    makeHumanoid: () => new THREE.Group(), HUMANOID_PRESETS: { shopkeeper: {}, woman: {} },
    makeSmokeSystem: () => ({ points: new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()) }),
    spawnFire(x, y, z) {
      const group = new THREE.Group(), light = new THREE.PointLight();
      group.position.set(x, y, z); group.userData.ballistics = false; group.add(light); World.add(group);
      return { group, light, smoke: { points: new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()) } };
    },
  }, { filename: 'street.js' });
  builders.buildStreet();
  builders.buildBakeryAndCar();
  World.updateMatrixWorld(true);
  return { World, WorldState, Triggers, records: new Map(Architecture.elements), boxes: [...Colliders.list] };
}

const fixture = buildFixture();
const bounds = (id) => fixture.records.get(id)?.bounds;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`);
const clear = ({ x, y, z }, lift = 0.02) => capsuleHasClearance(new THREE.Vector3(x, y + lift, z), 0.32, 1.84, fixture.boxes);

test('district contract is deeply immutable and expands street and bakery area', () => {
  function frozen(value) {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) if (child && typeof child === 'object') frozen(child);
  }
  frozen(DISTRICT);
  const road = DISTRICT.street.road, bakery = DISTRICT.bakery;
  assert.ok((road.x2 - road.x1) * (road.z2 - road.z1) > 50 * 12 * 2);
  assert.ok((bakery.x2 - bakery.x1) * (bakery.z2 - bakery.z1) > 9 * 8 * 3);
  assert.throws(() => { DISTRICT.bakery.spawnPockets[0].x = 0; }, TypeError);
});

test('pavement matches authored floors and never overlays the bakery interior', () => {
  for (const [id, spec] of [['street-road', DISTRICT.street.road], ['near-apron', DISTRICT.street.nearApron], ['far-sidewalk', DISTRICT.street.farWalk], ['bakery-floor', DISTRICT.bakery]]) {
    near(bounds(id).min.x, spec.x1, id + ' west');
    near(bounds(id).max.x, spec.x2, id + ' east');
    near(bounds(id).min.z, spec.z1, id + ' north');
    near(bounds(id).max.z, spec.z2, id + ' south');
    near(bounds(id).max.y, spec.floorY, id + ' surface');
  }
  near(bounds('near-apron').max.z, bounds('street-road').min.z, 'near curb join');
  near(bounds('street-road').max.z, bounds('far-sidewalk').min.z, 'far curb join');
  near(bounds('far-sidewalk').max.z, bounds('far-frontage-apron').min.z, 'frontage join');
  assert.ok(bounds('far-frontage-apron').min.x >= bounds('bakery-floor').max.x);
  assert.ok(bounds('far-frontage-west').max.x <= bounds('bakery-floor').min.x);
});

test('end boundaries are visible and no legacy x25 or z30 wall crosses the district', () => {
  for (const side of ['west', 'east']) {
    const record = fixture.records.get('street-boundary-' + side + '-fence');
    assert.ok(record.mesh.visible && record.collider);
    near(record.bounds.min.y, bounds('street-boundary-' + side + '-base').max.y, 'fence support');
    assert.ok(record.bounds.max.y > 3.3);
  }
  for (const old of [boxBounds(-25, 6, 12, 0.2, 12, 24), boxBounds(25, 6, 12, 0.2, 12, 24), boxBounds(0, 6, 30, 50, 12, 0.2)]) {
    assert.ok(!fixture.boxes.some((box) => box.equals(old)), 'old invisible barrier removed');
  }
  assert.ok(clear({ x: -30, y: 0.05, z: 16 }));
  assert.ok(clear({ x: 30, y: 0.05, z: 16 }));
  near(bounds('east-service-gate').min.x, 25 + BUILDING.wallThickness / 2, 'gate beyond annex');
});

test('all reserved street, finale and QA points have standing capsule clearance', () => {
  const points = [
    DISTRICT.street.checkpoint, ...DISTRICT.street.spawnPockets,
    DISTRICT.car.approach, ...DISTRICT.car.spawnPockets,
    DISTRICT.street.qa.firstGun, ...DISTRICT.street.qa.benchmark, DISTRICT.street.qa.wallShot,
  ];
  for (const point of points) assert.ok(clear(point), JSON.stringify(point));
});

test('the relocated car bay clears the complete randomized street and bodyguard arrivals', () => {
  for (const config of [ZONE_WAVE_CONFIG.street, FINAL_ENCOUNTERS.car]) {
    for (const point of config.spawns) {
      const envelope = new THREE.Box3(
        new THREE.Vector3(point.x - config.variation.jitterX - 0.48, point.y + 0.02, point.z - config.variation.jitterZ - 0.48),
        new THREE.Vector3(point.x + config.variation.jitterX + 0.48, point.y + 2.02, point.z + config.variation.jitterZ + 0.48),
      );
      assert.ok(fixture.boxes.every(box => !box.intersectsBox(envelope)),
        `${config.variation.key}: the entire arrival envelope at ${point.x},${point.z} clears the car and street furniture`);
    }
  }
});

test('street arrival can cross straight ahead or reach the bakery without entering the car choice', () => {
  const { street, bakery, car } = DISTRICT;
  const start = { x: street.checkpoint.x, y: street.road.floorY, z: street.road.z1 + 2 };
  const crossingZ = 18.7;
  const routes = [
    [start, street.checkpoint, { x: start.x, y: street.farWalk.floorY, z: 26.5 }],
    [start, street.checkpoint, { x: start.x, y: start.y, z: crossingZ },
      { x: bakery.accessRoute[0].x, y: start.y, z: crossingZ }, ...bakery.accessRoute],
  ];
  for (const route of routes) for (let index = 1; index < route.length; index++) {
    const from = route[index - 1], to = route[index];
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.1);
    for (let step = 0; step <= steps; step++) {
      const fraction = step / steps;
      const point = { x: from.x + (to.x - from.x) * fraction, y: Math.max(from.y, to.y), z: from.z + (to.z - from.z) * fraction };
      assert.ok(clear(point), `The street-to-bakery route remains clear at ${point.x},${point.z}`);
      assert.ok(Math.hypot(point.x - car.x, point.z - car.z) > car.commitRadius + 0.32,
        'The full player footprint stays outside the car commitment area');
    }
  }
  const bakeryTrigger = fixture.Triggers.list.find(trigger => trigger.name === 'bakery');
  assert.ok(new THREE.Box3(bakeryTrigger.min, bakeryTrigger.max).containsPoint(new THREE.Vector3(
    bakery.accessRoute[1].x, bakery.accessRoute[1].y + 1.72, bakery.accessRoute[1].z,
  )), 'The accessible entrance route reaches the real bakery zone trigger');
  assert.ok(Math.hypot(car.approach.x - car.x, car.approach.z - car.z) < car.commitRadius,
    'A deliberate walk to the relocated car still chooses her branch');
  assert.ok(Math.hypot(car.x - start.x, car.z - start.z) > 15,
    'The car sits well beyond the scaffold landing');
  assert.ok(Math.hypot(car.x - (bakery.door.x1 + bakery.door.x2) / 2, car.z - bakery.door.z) > 50,
    'The car has its own end of the block away from the bakery');
});

test('bakery checkpoint and spawn pockets clear furniture and stay away from entry', () => {
  const b = DISTRICT.bakery;
  assert.ok(clear(b.checkpoint));
  for (const point of b.spawnPockets) {
    assert.ok(clear(point), 'blocked pocket ' + JSON.stringify(point));
    assert.ok(Math.hypot(point.x - b.checkpoint.x, point.z - b.checkpoint.z) >= 5, 'spawn has entry separation');
    assert.ok(point.x > b.x1 && point.x < b.x2 && point.z > b.z1 && point.z < b.z2);
  }
});

test('standing route traverses the shop door and the preparation passage', () => {
  const path = DISTRICT.bakery.accessRoute;
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1], to = path[index];
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.1);
    for (let step = 0; step <= steps; step++) {
      const fraction = step / steps;
      const point = { x: from.x + (to.x - from.x) * fraction, y: Math.max(from.y, to.y), z: from.z + (to.z - from.z) * fraction };
      assert.ok(clear(point), 'route ' + JSON.stringify(point));
    }
  }
  near(bounds('bakery-partition-east').min.x - bounds('bakery-partition-west').max.x, 4, 'partition opening width');
  near(bounds('bakery-partition-lintel').min.y, 3.3, 'standing headroom');
});

test('every bakery spawn is connected to the entry through collision-free floor', () => {
  const b = DISTRICT.bakery, spacing = 0.5, nodes = new Map();
  const columns = Math.round((b.x2 - b.x1) / spacing) - 1;
  const rows = Math.round((b.z2 - b.z1) / spacing) - 1;
  for (let x = 0; x < columns; x++) for (let z = 0; z < rows; z++) {
    const point = { x: b.x1 + spacing * (x + 1), y: b.floorY, z: b.z1 + spacing * (z + 1) };
    if (clear(point)) nodes.set(x + ',' + z, { ...point, column: x, row: z });
  }
  function closest(point) {
    return [...nodes].reduce((best, entry) => Math.hypot(entry[1].x - point.x, entry[1].z - point.z) < Math.hypot(best[1].x - point.x, best[1].z - point.z) ? entry : best);
  }
  const start = closest(b.checkpoint)[0], visited = new Set([start]), queue = [start];
  for (let index = 0; index < queue.length; index++) {
    const node = nodes.get(queue[index]);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = (node.column + dx) + ',' + (node.row + dz), next = nodes.get(key);
      if (!next || visited.has(key)) continue;
      if (!clear({ x: (node.x + next.x) / 2, y: b.floorY, z: (node.z + next.z) / 2 })) continue;
      visited.add(key); queue.push(key);
    }
  }
  for (const point of b.spawnPockets) assert.ok(visited.has(closest(point)[0]), 'unreachable pocket ' + JSON.stringify(point));
});

test('bakery structure, furniture and facade accessories have matching supports', () => {
  for (const [base, top] of [['bakery-counter-base', 'bakery-counter-top'], ['bakery-prep-island-base', 'bakery-prep-island-top']]) {
    near(bounds(base).min.y, DISTRICT.bakery.floorY, base + ' floor');
    near(bounds(base).max.y, bounds(top).min.y, top + ' support');
  }
  near(bounds('bakery-ceiling').min.y, DISTRICT.bakery.ceilingY, 'clear ceiling');
  near(bounds('bakery-upper-volume').min.y, bounds('bakery-ceiling').max.y, 'upper storeys supported');
  near(bounds('bakery-roof').min.y, bounds('bakery-upper-volume').max.y, 'roof supported');
  const sign = fixture.World.getObjectByName('bakery-shop-sign');
  const fascia = bounds(sign.userData.mountId), awning = fixture.World.getObjectByName('bakery-street-awning');
  const signBounds = new THREE.Box3().setFromObject(sign), awningBounds = new THREE.Box3().setFromObject(awning);
  assert.ok(signBounds.min.y >= fascia.min.y && signBounds.max.y <= fascia.max.y);
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(sign.quaternion).z < -0.999);
  assert.ok(awningBounds.max.z < DISTRICT.bakery.z1 && awningBounds.intersectsBox(fascia));
  assert.ok(bounds('car-placard-backing').intersectsBox(bounds('car-placard-post')));
});

test('car remains transformable while detail parts are batched by material', () => {
  const car = fixture.WorldState.car;
  near(car.position.x, DISTRICT.car.x, 'car x');
  near(car.position.y, DISTRICT.car.y, 'car rests on road');
  near(car.position.z, DISTRICT.car.z, 'car z');
  assert.ok(car.children.length <= 8, 'each sedan has at most eight material batches');
  assert.ok(car.children.every((mesh) => mesh.isMesh && mesh.geometry.attributes.position.count > 0));
  const old = car.position.x;
  car.position.x += 1;
  car.updateMatrixWorld(true);
  assert.ok(car.children.every((mesh) => new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld).x === old + 1));
  car.position.x = old;
  car.updateMatrixWorld(true);
});
