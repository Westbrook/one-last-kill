import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createAmmoSupplies } from '../../src/game/ammo-supplies.js';
import { AMMO_SUPPLY_CACHES } from '../../src/game/ammo-supply-rules.js';
import { ZONE_WAVE_CONFIG } from '../../src/game/mission-data.js';
import { BUILDING, BALCONY, ROOF, OPENINGS, APARTMENT_DOORS } from '../../src/world/layout.js';
import { STAIRS } from '../../src/world/stair-layout.js';
import { Architecture, boxBounds, signYaw } from '../../src/world/architecture.js';
import { Colliders, capsuleHasClearance, moveCapsule } from '../../src/core/collision.js';
import { applyWaterTankStaveUV } from '../../src/render/water-tank-uv.js';
import { createAuthoredWorldDressingGeometry, refineAuthoredDressingMesh } from '../../src/render/authored-world-dressing.js';

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`);

// The real builders supply every wall, floor, guard, HVAC and prop. Only their
// canvas materials and scene services are injected; this creates no renderer,
// browser or sound device. Shared structures keep their exact geometry too.
function buildFixture() {
  Architecture.clear(); Colliders.clear();
  const World = new THREE.Group(), materials = new Map();
  const MATS = new Proxy({}, { get(_, key) {
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial());
    return materials.get(key);
  } });
  const _BG = { unitBox: new THREE.BoxGeometry(1, 1, 1), pipe: new THREE.CylinderGeometry(1, 1, 1, 8) };
  function addBox(x, y, z, sx, sy, sz, material, options = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.position.set(x, y, z); World.add(mesh);
    const collider = options.collide === false ? null : Colliders.addBoxBySize(x, y, z, sx, sy, sz);
    mesh.userData.collider = collider;
    if (options.architecture) Architecture.register(mesh, collider, boxBounds(x, y, z, sx, sy, sz), options.architecture);
    return mesh;
  }
  function pushDecor(geometry, material, x, y, z, sx, sy, sz, yaw = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.rotation.y = yaw; World.add(mesh);
  }
  function addSign(x, y, z, width, height, normal) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), MATS.metal);
    mesh.position.set(x, y, z); mesh.rotation.y = signYaw(normal); World.add(mesh);
    return mesh;
  }
  const source = path => {
    const code = readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/^import .*;\s*$/gm, '').replace(/^export (?=function )/gm, '');
    assert.doesNotMatch(code, /^import\s/m, 'Keep this geometry harness explicit if builder imports change');
    return code;
  };
  const context = {
    THREE, mergeGeometries, World, MATS, _BG, Colliders, Architecture, boxBounds, applyWaterTankStaveUV,
    createAuthoredWorldDressingGeometry, refineAuthoredDressingMesh,
    BUILDING, BALCONY, ROOF, OPENINGS, APARTMENT_DOORS, STAIRS, addBox, pushDecor, addSign,
    Triggers: { add() {} },
    addDecor: (x, y, z, sx, sy, sz, material) => addBox(x, y, z, sx, sy, sz, material, { collide: false }),
    makeCanvas: size => ({ width: size, height: size, getContext: () => ({
      beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
    }) }),
  };
  Object.assign(context, runInNewContext(source('../../src/world/structures.js') + '\n({addBeam,addProtectiveScreen});', { ...context }));
  for (const [module, builder] of [['roof', 'buildRoof'], ['balcony', 'buildBalcony'], ['stairwell', 'buildStairwell']]) {
    runInNewContext(source(`../../src/world/zones/${module}.js`) + `\n${builder}();`, { ...context });
  }
  World.updateMatrixWorld(true);
  const originalColliders = [...Colliders.list];
  const player = { pos: new THREE.Vector3(), _eyeH: 1.72 };
  const supplies = createAmmoSupplies();
  supplies.init({ world: World, player, canInteract: () => true });
  return { World, originalColliders, player, supplies };
}

function movePlayer(player, point) {
  player.pos.set(point.x, point.y + player._eyeH, point.z);
}

function walkRoute(from, targets) {
  const body = {
    position: new THREE.Vector3(from[0], from[1] + 0.02, from[2]),
    velocity: new THREE.Vector3(), radius: 0.32, height: 1.84, onGround: true,
  };
  for (const [x, y, z] of targets) {
    for (let tick = 0; tick < 2400; tick++) {
      const dx = x - body.position.x, dz = z - body.position.z, distance = Math.hypot(dx, dz);
      if (distance < 0.035 && Math.abs(body.position.y - y) < 0.05) break;
      const speed = Math.min(4.2, distance * 120);
      body.velocity.set(dx / Math.max(distance, 0.0001) * speed, body.velocity.y - 22 / 120, dz / Math.max(distance, 0.0001) * speed);
      moveCapsule(body, 1 / 120, Colliders.list, true);
    }
    assert.ok(body.position.distanceTo(new THREE.Vector3(x, y, z)) < 0.06,
      `Supply route stopped at ${body.position.toArray()}, expected ${[x, y, z]}`);
    assert.ok(capsuleHasClearance(body.position, body.radius, body.height, Colliders.list));
  }
}

test('all three low ammo cases rest on real builder floors and remain outside existing cover', () => {
  const { supplies, originalColliders } = buildFixture();
  assert.equal(supplies.list.length, 3);
  for (const [index, entry] of supplies.list.entries()) {
    const config = AMMO_SUPPLY_CACHES[index];
    const record = Architecture.elements.get('ammo-cache-' + entry.id);
    const support = Architecture.elements.get(config.support);
    const measured = new THREE.Box3().setFromObject(entry.mesh);
    assert.ok(support, `${entry.id} has an actual registered deck`);
    assert.equal(record.supportKind, 'bearing');
    assert.deepEqual(record.supports, [config.support]);
    near(measured.min.y, config.floorY, `${entry.id} bottom`);
    near(support.bounds.max.y, config.floorY, `${entry.id} support`);
    near(measured.max.y - measured.min.y, config.height, `${entry.id} total case height`);
    assert.ok(measured.max.y - measured.min.y < 0.4, 'An ammo case must read as a low floor object');
    assert.ok(measured.min.x >= support.bounds.min.x && measured.max.x <= support.bounds.max.x);
    assert.ok(measured.min.z >= support.bounds.min.z && measured.max.z <= support.bounds.max.z);
    assert.ok(measured.min.distanceTo(record.bounds.min) < 1e-5 && measured.max.distanceTo(record.bounds.max) < 1e-5);
    assert.ok(measured.min.distanceTo(entry.collider.min) < 1e-5 && measured.max.distanceTo(entry.collider.max) < 1e-5);
    assert.ok(entry.interactionPosition.y > measured.max.y);
    if (config.zone === 'balcony') {
      // Match the visible combat corridor, which is stricter than checking a
      // capsule only on the .95 m centerline. No latch may project into it.
      const combatLane = new THREE.Box3(
        new THREE.Vector3(BALCONY.wrap.x1, BALCONY.floorY + 0.02, 0.42),
        new THREE.Vector3(BALCONY.wrap.x2, BALCONY.floorY + 2.64, 1.48),
      );
      assert.equal(measured.intersectsBox(combatLane), false, 'The complete visible box preserves the declared balcony fight lane');
      assert.ok(measured.min.z > BUILDING.wallThickness / 2, 'The box also stays outside the actual facade');
    }
    for (const existing of originalColliders) {
      if (existing.max.y <= config.floorY + 1e-5 || existing.min.y >= measured.max.y) continue;
      assert.equal(measured.intersectsBox(existing), false, `${entry.id} must not intersect existing world geometry`);
    }
  }
});

test('new cases preserve every balcony, stair and roof spawn capsule and both traversal routes', () => {
  buildFixture();
  for (const zone of ['balcony', 'stairwell', 'roof']) {
    for (const point of ZONE_WAVE_CONFIG[zone].spawns) {
      assert.ok(capsuleHasClearance(new THREE.Vector3(point.x, point.y + 0.03, point.z), 0.48, 2.02, Colliders.list),
        `${zone} spawn at ${JSON.stringify(point)} must retain the full director clearance`);
    }
  }
  const balcony = ZONE_WAVE_CONFIG.balcony.route;
  walkRoute([balcony.points[0].x, balcony.floorY, balcony.points[0].z], [
    ...balcony.points.slice(1).map(point => [point.x, balcony.floorY, point.z]),
    [-18, STAIRS.entryY, -0.65],
  ]);
  walkRoute(ROOF.route[0], ROOF.route.slice(1));
});

test('both rooftop cover pockets are reachable on foot and their top targets allow normal pickup', () => {
  const { supplies, player } = buildFixture();
  const [west, east] = AMMO_SUPPLY_CACHES.filter(cache => cache.zone === 'roof');
  const point = cache => [cache.approach.x, cache.approach.y, cache.approach.z];
  walkRoute(ROOF.route[0], [ROOF.route[1], point(west), ROOF.route[1], ROOF.route[2], point(east), ROOF.route[3]]);
  const held = { current: 'pistol', loaded: 3, reserve: 0 };
  for (const config of AMMO_SUPPLY_CACHES) {
    supplies.setZone(config.zone);
    movePlayer(player, config.approach);
    const entry = supplies.list.find(item => item.id === config.id);
    assert.ok(capsuleHasClearance(new THREE.Vector3(config.approach.x, config.floorY + 0.02, config.approach.z), 0.32, 1.84, Colliders.list));
    assert.equal(supplies.findNearest(held), entry, `${entry.id} is reachable without its collider occluding the lid`);
    assert.match(supplies.prompt(entry, held), /\[E\].*24 PISTOL AMMO/);
  }
});

test('case shapes, lid and front labels share a bounded geometry and material budget', () => {
  const { supplies } = buildFixture();
  const geometries = new Set(), materials = new Set();
  let meshes = 0, triangles = 0;
  for (const entry of supplies.list) {
    const labels = entry.mesh.getObjectByName('ammo-case-lid-and-front-labels');
    assert.equal(labels.count, 2);
    const transform = new THREE.Matrix4(), normalMatrix = new THREE.Matrix3();
    labels.getMatrixAt(0, transform);
    const topNormal = new THREE.Vector3(0, 0, 1).applyNormalMatrix(normalMatrix.getNormalMatrix(transform));
    assert.ok(topNormal.y > 0.999, 'The AMMO lid label faces the standing player above the case');
    labels.getMatrixAt(1, transform);
    const frontNormal = new THREE.Vector3(0, 0, 1).applyNormalMatrix(normalMatrix.getNormalMatrix(transform));
    assert.ok(frontNormal.z > 0.999, 'A second AMMO label remains readable on the front face');
    assert.equal(entry.mesh.getObjectByName('ammo-case-handle-and-latches').count, 5);
    assert.equal(entry.mesh.getObjectByName('ammo-case-body-and-lid').count, 2);
    entry.mesh.traverse(object => {
      assert.equal(Boolean(object.isLight), false);
      if (!object.isMesh) return;
      meshes++; geometries.add(object.geometry); materials.add(object.material);
      triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3 * (object.isInstancedMesh ? object.count : 1);
    });
  }
  assert.equal(meshes, 15);
  assert.equal(geometries.size, 3);
  assert.equal(materials.size, 5);
  assert.ok(triangles <= 2400, `All three cases must stay inexpensive to render: ${triangles} triangles`);
});
