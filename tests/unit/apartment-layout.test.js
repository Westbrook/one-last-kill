import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Architecture, boxBounds, signYaw } from '../../src/world/architecture.js';
import { BUILDING, BALCONY, APARTMENT_DOORS, OPENINGS } from '../../src/world/layout.js';
import { createInteriorProps } from '../../src/world/interior-props.js';
import { createDoorAssemblies } from '../../src/world/door-assemblies.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';

// Execute the actual room builders with real geometry and collision math.
// Browser-facing materials, fire shaders and lights need no renderer here;
// the harness never opens a browser or allocates an audio context.
function buildApartments({ withBalcony = false } = {}) {
  Architecture.clear(); Colliders.clear();
  const World = new THREE.Group(), materials = new Map(), decorations = [], fires = [], triggers = new Map();
  const Ballistics = createBallisticWorld();
  const MATS = new Proxy({}, {
    get(_, key) {
      if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial());
      return materials.get(key);
    },
  });
  const _BG = { unitBox: new THREE.BoxGeometry(1, 1, 1), pipe: new THREE.CylinderGeometry(1, 1, 1, 8) };
  function addBox(x, y, z, width, height, depth, material, options = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z); World.add(mesh);
    const collider = options.collide === false ? null : Colliders.addBoxBySize(x, y, z, width, height, depth);
    mesh.userData.collider = collider;
    if (options.architecture) Architecture.register(mesh, collider, boxBounds(x, y, z, width, height, depth), options.architecture);
    return mesh;
  }
  function pushDecor(geometry, material, x, y, z, width, height, depth, yaw = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.scale.set(width, height, depth); mesh.rotation.y = yaw;
    World.add(mesh); decorations.push(mesh);
  }
  function addWallZ(x, floor, z, length, height, thickness, material, opening) {
    const low = z - length / 2, high = z + length / 2;
    const { zStart, zEnd, headerH, sillH } = opening;
    for (const [start, end] of [[low, zStart], [zEnd, high]]) {
      addBox(x, floor + height / 2, (start + end) / 2, thickness, height, end - start, material);
    }
    addBox(x, floor + height - headerH / 2, (zStart + zEnd) / 2, thickness, headerH, zEnd - zStart, material);
    if (sillH) addBox(x, floor + sillH / 2, (zStart + zEnd) / 2, thickness, sillH, zEnd - zStart, material);
  }
  function addSign(x, y, z, width, height, normal) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), MATS.metal);
    mesh.position.set(x, y, z); mesh.rotation.y = signYaw(normal); World.add(mesh);
    return mesh;
  }
  const bindings = {
    THREE, World, MATS, _BG, BUILDING, BALCONY, APARTMENT_DOORS, Colliders, Ballistics, addBox, pushDecor, addWallZ, addSign, createInteriorProps, createDoorAssemblies,
    addDecor: (x, y, z, width, height, depth, material) => addBox(x, y, z, width, height, depth, material, { collide: false }),
    addFlickerLight() {}, makeSignTexture: () => new THREE.Texture(),
    Triggers: { add(id, min, max, enter, reset) { triggers.set(id, { min, max, enter, reset }); } },
    spawnFire(x, y, z, { blockHeight, blockWidth, blockDepth = blockWidth }) {
      const group = new THREE.Group(), light = new THREE.PointLight();
      group.add(light); World.add(group);
      const collider = Colliders.addBoxBySize(x, y + blockHeight / 2, z, blockWidth, blockHeight, blockDepth);
      const entry = { group, light, collider, active: true };
      fires.push(entry); return entry;
    },
    setFireActive(entry, active) {
      entry.active = active; entry.group.visible = active; Colliders.setEnabled(entry.collider, active);
    },
  };
  function runBuilder(path, suffix, context = bindings) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/^import .*;\s*$/gm, '')
      .replace(/^export \{[^}]+\};\s*$/gm, '')
      .replace(/^export (?=function )/gm, '');
    assert.doesNotMatch(source, /^import\s/m, 'Keep the explicit builder harness current when imports change');
    return runInNewContext(`${source}\n${suffix}`, context);
  }
  runBuilder('../../src/world/zones/apartments.js', 'buildPlayerApartment(); buildNeighborApartment();');
  if (withBalcony) {
    const structures = runBuilder('../../src/world/structures.js', '({ addBeam, addProtectiveScreen });', {
      ...bindings, mergeGeometries, Architecture, boxBounds,
      makeCanvas: () => ({ getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {} }) }),
    });
    runBuilder('../../src/world/zones/balcony.js', 'buildBalcony();', { ...bindings, ...structures });
  }
  World.updateMatrixWorld(true);
  Ballistics.rebuild(World);
  return { World, decorations, fires, triggers, records: new Map(Architecture.elements), boxes: [...Colliders.list] };
}

const apartmentRoute = [[-9, -4], [-8.5, -4], [-8.5, -6], [-4, -6]];
const neighborRoute = [[-0.6, -6], [-0.1, -4.2], [1.9, -3.8], [5.6, -3.8], [5.6, -5.5], [8.5, -5.5]];
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`);

function assertClearRoute(route, boxes, radius = 0.5) {
  for (let segment = 1; segment < route.length; segment++) {
    const start = new THREE.Vector3(route[segment - 1][0], 4.02, route[segment - 1][1]);
    const end = new THREE.Vector3(route[segment][0], 4.02, route[segment][1]);
    const steps = Math.ceil(start.distanceTo(end) / 0.08);
    for (let i = 0; i <= steps; i++) {
      const point = start.clone().lerp(end, i / steps);
      assert.ok(capsuleHasClearance(point, radius, 1.84, boxes), `clear route at ${point.toArray().join(', ')}`);
    }
  }
}

test('both checkpoints reach their exits through metre-wide interior routes', () => {
  const { boxes } = buildApartments();
  assertClearRoute(apartmentRoute, boxes);
  assertClearRoute(neighborRoute, boxes);
  assertClearRoute([[-12.24, -5.8], [-12.24, -8.1]], boxes);
  assert.ok(capsuleHasClearance(new THREE.Vector3(9, 4.02, -5.5), 0.5, 1.84, boxes), 'balcony opening stays clear');
  assert.ok(capsuleHasClearance(new THREE.Vector3(-3, 4.53, -6), 0.32, 1.84, boxes), 'original breach sill remains jumpable');
});

test('walking the actual collision geometry needs no new jump or step', () => {
  const { boxes } = buildApartments();
  for (const route of [apartmentRoute, neighborRoute]) {
    const body = {
      position: new THREE.Vector3(route[0][0], 4.02, route[0][1]),
      velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true,
    };
    for (const [x, z] of route.slice(1)) {
      for (let frame = 0; frame < 360; frame++) {
        const dx = x - body.position.x, dz = z - body.position.z, distance = Math.hypot(dx, dz);
        if (distance < 0.025) break;
        const speed = Math.min(2.5, distance * 60);
        body.velocity.set(dx / distance * speed, -0.35, dz / distance * speed);
        moveCapsule(body, 1 / 60, boxes, false);
        assert.ok(body.position.y >= 3.999 && body.position.y <= 4.021, 'room route stays on its floor');
      }
      assert.ok(Math.hypot(x - body.position.x, z - body.position.z) < 0.025, `walk reaches ${x}, ${z}`);
    }
  }
});

test('opening melee and mixed encounter pockets stay clear of furniture', () => {
  const { boxes } = buildApartments();
  const spawns = [[-5, -8.5], [-10.6, -8.8], [-13, -5.35], [-5, -3.45], [5.8, -2.2], [7.5, -3.2], [3.4, -8.4], [7, -7.9]];
  for (const [x, z] of spawns) {
    assert.ok(capsuleHasClearance(new THREE.Vector3(x, 4.02, z), 0.4, 1.84, boxes), `spawn ${x}, ${z}`);
  }
  for (const x of [-10.3, -9.8, -9.3, -8.8, -8.3, -8]) {
    for (const z of [-4, -3.5, -3, -2.6]) {
      assert.ok(capsuleHasClearance(new THREE.Vector3(x, 4.02, z), 0.4, 1.84, boxes), `starting sidestep ${x}, ${z}`);
    }
  }
});

test('new partitions create separate rooms with supported, sill-free doorways', () => {
  const { records, boxes } = buildApartments();
  for (const id of ['apartment-hall-north', 'apartment-hall-south', 'apartment-bedroom-east', 'apartment-bedroom-front', 'neighbor-foyer-north', 'neighbor-foyer-south']) {
    near(records.get(id).bounds.min.y, 4, `${id} foot`);
    near(records.get(id).bounds.max.y, BUILDING.canopyY, `${id} ceiling`);
  }
  near(records.get('neighbor-foyer-header').bounds.min.y, 6.35, 'foyer door height');
  near(records.get('apartment-bedroom-header').bounds.min.y, 6.2, 'bedroom door height');
  const ray = new THREE.Ray(new THREE.Vector3(-0.6, 5.65, -6), new THREE.Vector3(1, 0, 0));
  assert.ok(ray.intersectsBox(records.get('neighbor-foyer-north').bounds), 'foyer breaks the old straight sightline');
  assert.ok(capsuleHasClearance(new THREE.Vector3(1, 4.02, -4.2), 0.5, 1.84, boxes), 'foyer door has no threshold collider');
});

test('furniture matches its collider, rests on supports and keeps detail batched', () => {
  const { records, World, decorations } = buildApartments();
  for (const record of records.values()) {
    if (record.kind !== 'furniture' && record.kind !== 'partition' && record.kind !== 'lintel') continue;
    const actual = new THREE.Box3().setFromObject(record.mesh);
    assert.ok(actual.min.distanceTo(record.bounds.min) < 1e-5 && actual.max.distanceTo(record.bounds.max) < 1e-5, record.id);
    if (record.collider) assert.ok(record.collider.equals(record.bounds), `${record.id} visible collider`);
    assert.ok(record.supports.length > 0, `${record.id} has supports`);
    for (const id of record.supports) {
      const support = records.get(id);
      assert.ok(support, `${record.id} support ${id} exists`);
      assert.ok(record.bounds.clone().expandByScalar(0.002).intersectsBox(support.bounds), `${record.id} touches ${id}`);
      if (record.supportKind === 'bearing') near(record.bounds.min.y, support.bounds.max.y, `${record.id} rests on ${id}`);
    }
  }
  let lights = 0;
  World.traverse(object => { if (object.isPointLight) lights++; });
  assert.equal(lights, 5, 'room furnishing adds no point lights beyond the original lamps, CRT and two fires');
  assert.ok(decorations.length > 300, 'small furniture details use the shared batching path');
  assert.ok(decorations.every(mesh => !mesh.userData.collider), 'small decorative relief creates no invisible obstacles');
});

test('neighbor breach gate reuses its fire and debris across full resets', () => {
  const { World, fires, triggers } = buildApartments();
  const trigger = triggers.get('neighbor');
  trigger.enter();
  assert.equal(fires.length, 3);
  const debris = World.getObjectByName('neighbor-breach-debris'), gateFire = fires[2];
  const colliderCount = Colliders.list.length, objectCount = World.children.length;
  for (let i = 0; i < 3; i++) {
    trigger.reset();
    assert.equal(debris.visible, false);
    assert.equal(gateFire.active, false);
    assert.equal(Colliders.isEnabled(debris.userData.collider), false);
    trigger.enter();
    assert.equal(debris.visible, true);
    assert.equal(gateFire.active, true);
    assert.equal(Colliders.list.length, colliderCount);
    assert.equal(World.children.length, objectCount);
    assert.equal(fires.length, 3);
  }
});

test('the burned entrance has one visible door in the same opening from both sides', () => {
  const { World, records } = buildApartments({ withBalcony: true });
  const entry = APARTMENT_DOORS.playerEntry;
  const slab = World.getObjectByName(`${entry.id}-slab`);
  let leafCount = 0;
  World.traverse(object => { if (object.userData.doorId === entry.id && object.userData.doorPart === 'slab') leafCount++; });
  assert.equal(leafCount, 1, 'the inside and outside use one physical leaf');
  assert.ok(slab && slab.userData.collider, 'the closed leaf owns its visible collision');
  const slabBounds = new THREE.Box3().setFromObject(slab);
  near((slabBounds.min.x + slabBounds.max.x) / 2, entry.x, 'leaf x');
  near((slabBounds.min.z + slabBounds.max.z) / 2, entry.z, 'leaf wall plane');
  near(slabBounds.max.z - slabBounds.min.z, entry.slabThickness, 'physical leaf thickness');
  const innerHandle = World.getObjectByName(`${entry.id}-interior-handle`);
  const outerHandle = World.getObjectByName(`${entry.id}-exterior-handle`);
  near(innerHandle.position.x, outerHandle.position.x, 'handles share a through-leaf spindle x');
  near(innerHandle.position.y, outerHandle.position.y, 'handles share a through-leaf spindle height');
  assert.ok(innerHandle.position.z < entry.z && outerHandle.position.z > entry.z);

  // Cast against actual solid scene meshes; paint and fire effects do not
  // substitute for checking whether an uncut wall still hides the leaf.
  const solids = World.children.filter(object => object.userData.collider);
  for (const side of [-1, 1]) {
    const raycaster = new THREE.Raycaster(new THREE.Vector3(entry.x + 0.15, entry.floorY + 1.3, entry.z + side * 0.6),
      new THREE.Vector3(0, 0, -side), 0, 1.2);
    const hit = raycaster.intersectObjects(solids, true)[0];
    assert.ok(hit, `door face visible from ${side < 0 ? 'inside' : 'gallery'}`);
    assert.equal(hit.object.userData.doorId, entry.id, 'first visible surface belongs to the actual door');
    const paintedFace = raycaster.intersectObject(World, true)[0];
    assert.ok(Math.abs(paintedFace.point.z - entry.z) <= entry.slabThickness / 2 + 0.014,
      'the nearest rendered surface is the recessed leaf or its paint, not a wall hiding the door');
  }
  const wall = records.get('apartment-entry-wall-header').bounds;
  near(wall.min.y, records.get(`${entry.id}-header`).bounds.max.y, 'wall lintel sits on door header');
  const plate = World.getObjectByName(`${entry.id}-exterior-number`);
  assert.equal(plate.userData.doorId, entry.id);
  near(plate.position.x, entry.x, 'gallery number belongs to the same opening');
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(plate.quaternion).z > 0.999);
});

test('the closed entrance remains a barrier even without its story fire', () => {
  const fixture = buildApartments({ withBalcony: true });
  const boxes = fixture.boxes.filter(box => !fixture.fires.some(fire => fire.collider === box));
  const entry = APARTMENT_DOORS.playerEntry;
  for (const side of [-1, 1]) {
    const body = { position: new THREE.Vector3(entry.x, entry.floorY + 0.02, entry.z + side * 0.6),
      velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true };
    for (let frame = 0; frame < 90; frame++) {
      body.velocity.set(0, -0.2, -side * 2);
      moveCapsule(body, 1 / 60, boxes, true);
    }
    assert.ok((body.position.z - entry.z) * side > 0.32, 'same leaf stops approach from either face');
    near(body.position.y, entry.floorY, 'no new floor jump at the closed entrance');
  }
});

test('the neighboring through-frame and exterior gallery retain bidirectional walking clearance', () => {
  const { World, boxes, records } = buildApartments({ withBalcony: true });
  const door = APARTMENT_DOORS.neighborTerrace;
  assert.equal(World.getObjectByName(`${door.id}-slab`), undefined, 'the authored open passage is not sealed');
  near(records.get(`${door.id}-threshold`).bounds.max.y, door.floorY, 'open threshold remains flush');
  const opening = OPENINGS.neighborBalcony;
  assert.deepEqual([...opening.min], [8.89, 4, -7]);
  assert.deepEqual([...opening.max], [9.11, 6.9, -3]);
  for (const z of [-6.45, -5.5, -3.55]) {
    assertClearRoute([[8.4, z], [10.4, z]], boxes);
  }
  for (const [start, end] of [[8.3, 10.3], [10.3, 8.3]]) {
    const body = { position: new THREE.Vector3(start, door.floorY + 0.02, -5.5),
      velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true };
    for (let frame = 0; frame < 60; frame++) {
      body.velocity.set((end - start), -0.2, 0);
      moveCapsule(body, 1 / 60, boxes, false);
    }
    assert.ok(Math.abs(body.position.x - end) < 0.002, 'walk crosses the open frame without obstruction');
    near(body.position.y, door.floorY, 'no added sill requires stepping');
  }
  assertClearRoute([[11, -4.5], [11, BALCONY.laneZ], [-18, BALCONY.laneZ]], boxes);
  const number = World.getObjectByName(`${door.id}-exterior-number`);
  near(number.position.z, door.z, 'terrace number aligns to the actual opening');
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(number.quaternion).x > 0.999);
});

test('shared exterior-door data is frozen and the linen cupboard stays interior storage', () => {
  const { World, records } = buildApartments({ withBalcony: true });
  assert.ok(Object.isFrozen(APARTMENT_DOORS));
  for (const value of Object.values(APARTMENT_DOORS)) assert.ok(Object.isFrozen(value));
  const cupboard = records.get('neighbor-linen-cupboard');
  assert.ok(cupboard.bounds.max.z <= -BUILDING.wallThickness / 2 + 1e-8, 'cabinet does not emerge on the facade');
  assert.ok(cupboard.bounds.max.z - cupboard.bounds.min.z > 0.4, 'storage has visible usable depth');
  assert.equal(cupboard.mesh.userData.doorId, undefined, 'cabinet doors are not registered exterior doors');
  const ids = new Set();
  World.traverse(object => { if (object.userData.doorId) ids.add(object.userData.doorId); });
  assert.deepEqual([...ids].sort(), ['apartment-entry', 'neighbor-terrace']);
});

test('door frames, wall returns and address plates retain physical support contacts', () => {
  const { records } = buildApartments({ withBalcony: true });
  for (const record of records.values()) {
    if (!record.id.startsWith('apartment-entry') && !record.id.startsWith('neighbor-terrace')) continue;
    const actual = new THREE.Box3().setFromObject(record.mesh);
    assert.ok(actual.min.distanceTo(record.bounds.min) < 1e-5 && actual.max.distanceTo(record.bounds.max) < 1e-5, record.id);
    if (record.collider) assert.ok(record.collider.equals(record.bounds), `${record.id} has matching visible collision`);
    assert.ok(record.supports.length > 0, `${record.id} names a real support`);
    for (const id of record.supports) {
      const support = records.get(id);
      assert.ok(support, `${record.id} support ${id} exists`);
      assert.ok(record.bounds.clone().expandByScalar(0.002).intersectsBox(support.bounds), `${record.id} touches ${id}`);
      if (record.supportKind === 'bearing') near(record.bounds.min.y, support.bounds.max.y, `${record.id} rests on ${id}`);
    }
  }
});

test('shared furniture builders keep floor-centred dimensions under every quarter turn', () => {
  const bodies = [], details = [];
  const props = createInteriorProps({
    addBox(...args) { const body = { args }; bodies.push(body); return body; },
    pushDecor(...args) { details.push(args); },
    boxGeometry: {}, pipeGeometry: {},
    materials: { wood: {}, metal: {}, tar: {}, plaster: {}, wallpaper: {} },
  });
  const defaults = { refrigerator: [0.68, 0.72, 1.85], stove: [0.72, 0.68, 0.92],
    sideboard: [1.6, 0.42, 1], bookcase: [1.4, 0.36, 2.1], bench: [1.2, 0.42, 0.45] };
  for (const [kind, [width, depth, height]] of Object.entries(defaults)) {
    for (const turns of [-2, -1, 0, 1, 2, 3, 4]) {
      const before = bodies.length, detailStart = details.length;
      const body = props[kind]({ id: kind, x: 3, z: -6, floorY: 4, floorId: 'floor', yaw: turns * Math.PI / 2 });
      assert.equal(bodies.length, before + 1, `${kind} has one solid body`);
      assert.equal(body, bodies.at(-1));
      const [x, y, z, sx, sy, sz, , options] = body.args;
      near(x, 3, 'fixture x'); near(z, -6, 'fixture z'); near(y - sy / 2, 4, 'fixture floor');
      near(sy, height, `${kind} height`);
      near(sx, turns % 2 ? depth : width, `${kind} rotated width`);
      near(sz, turns % 2 ? width : depth, `${kind} rotated depth`);
      assert.deepEqual(options.architecture.supports, ['floor']);
      const canonicalYaw = (((turns % 4) + 4) % 4) * Math.PI / 2;
      for (const detail of details.slice(detailStart)) {
        near(detail[8], canonicalYaw, 'detail faces same direction as solid body');
        assert.ok(detail[3] - detail[6] / 2 >= 4 - 1e-8, 'detail never extends below the floor');
      }
    }
    const override = props[kind]({ id: kind, x: 3, z: -6, floorY: 4, floorId: 'floor',
      yaw: Math.PI / 2, width: 1.2, depth: 0.6, height: 1.4 });
    near(override.args[3], 0.6, 'overridden rotated width');
    near(override.args[4], 1.4, 'overridden height');
    near(override.args[5], 1.2, 'overridden rotated depth');
    assert.throws(() => props[kind]({ x: 0, z: 0, floorY: 4, yaw: 0.2 }), /multiple/);
    assert.throws(() => props[kind]({ x: 0, z: 0, floorY: 4, depth: 0 }), /positive/);
    assert.throws(() => props[kind]({ x: 0, z: 0, floorY: 4, floorId: 'floor' }), /requires an id/);
  }
});
