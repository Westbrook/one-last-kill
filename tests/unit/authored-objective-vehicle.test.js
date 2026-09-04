import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSedanCabin } from '../../src/render/sedan-cabin.js';
import { createSedanBumper, createSedanHood } from '../../src/render/sedan-panels.js';

const CATEGORIES = ['paint', 'trim', 'glass', 'tires', 'metal', 'rearlamps', 'headlamps'];
const streetSource = readFileSync(new URL('../../src/world/zones/street.js', import.meta.url), 'utf8');
const factoryStart = streetSource.indexOf('function spawnParkedCar(');
const factoryEnd = streetSource.indexOf('/** Retail, preparation and refuge areas', factoryStart);
assert.ok(factoryStart >= 0 && factoryEnd > factoryStart, 'Extract the actual objective factory and its helpers');
const factorySource = streetSource.slice(factoryStart, factoryEnd);
const cacheSource = readFileSync(new URL('../../src/render/models.js', import.meta.url), 'utf8')
  .match(/const _CG = \{[^]*?\n\};/)?.[0];
assert.ok(cacheSource, 'Use the production fallback geometry cache');
const sharedCache = runInNewContext(`${cacheSource}\n;_CG;`, { THREE });

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${label}: ${actual} differs from ${expected}`);

// These surfaces only exercise the factory seam. Separate loader/asset tests
// validate the shipped GLB, while this fixture can also run before it exists.
function authoredFixture() {
  const geometry = Object.fromEntries(CATEGORIES.map((category, index) => [category,
    new THREE.BoxGeometry(0.4 + index * 0.03, 0.2, 0.3).translate(index * 0.15, 0.4, 0)]));
  return { geometry, resources: Object.freeze({ triangles: 84, draws: 7, textures: 0 }) };
}

function harness({ authored = authoredFixture(), forbidProcedural = false } = {}) {
  const World = new THREE.Group(), colliderCalls = [], lookupCalls = [];
  const unexpected = operation => { throw new Error(`Authored objective unexpectedly invoked ${operation}`); };
  const runtimeThree = forbidProcedural ? new Proxy({ ...THREE }, {
    get(target, key) {
      if (typeof key === 'string' && key.endsWith('Geometry')) return function () { unexpected(key); };
      return target[key];
    },
  }) : THREE;
  const spawnParkedCar = runInNewContext(`${factorySource}\n;spawnParkedCar;`, {
    THREE: runtimeThree, World,
    Colliders: { addBoxBySize(...args) { colliderCalls.push(args); return args; } },
    getAuthoredVehicleGeometry(variant) { lookupCalls.push(variant); return authored; },
    _CG: forbidProcedural ? new Proxy({}, { get() { unexpected('_CG cache'); } }) : sharedCache,
    RoundedBoxGeometry: forbidProcedural ? function () { unexpected('RoundedBoxGeometry'); } : RoundedBoxGeometry,
    mergeGeometries: forbidProcedural ? () => unexpected('geometry consolidation') : mergeGeometries,
    createSedanCabin: forbidProcedural ? () => unexpected('procedural cabin') : createSedanCabin,
    createSedanBumper: forbidProcedural ? () => unexpected('procedural bumper') : createSedanBumper,
    createSedanHood: forbidProcedural ? () => unexpected('procedural hood') : createSedanHood,
  }, { filename: 'src/world/zones/street.js' });
  return { spawnParkedCar, World, colliderCalls, lookupCalls, authored };
}

function byCategory(car, authored) {
  return Object.fromEntries(CATEGORIES.map(category => {
    const mesh = car.children.find(child => child.geometry === authored.geometry[category]);
    assert.ok(mesh?.isMesh, `The ${category} surface uses its cached authored geometry`);
    return [category, mesh];
  }));
}

function checkColliders(calls, { x, y, z, yaw, length, width }) {
  const cosine = Math.abs(Math.cos(yaw)), sine = Math.abs(Math.sin(yaw));
  const expected = [
    [x, y + 0.45, z, cosine * (length + 0.2) + sine * (width + 0.2), 0.9,
      sine * (length + 0.2) + cosine * (width + 0.2)],
    [x - 0.1 * Math.cos(yaw), y + 1.15, z + 0.1 * Math.sin(yaw),
      cosine * length * 0.55 + sine * width, 0.72, sine * length * 0.55 + cosine * width],
  ];
  assert.equal(calls.length, 2, 'Exactly the existing lower body and cabin colliders are registered');
  calls.forEach((actual, index) => {
    assert.equal(actual.length, 6);
    actual.forEach((value, component) => near(value, expected[index][component], `Collider ${index}/${component}`));
  });
}

test('authored objective preserves its placement, material batches, shadows and source metadata', () => {
  const h = harness({ forbidProcedural: true });
  const car = h.spawnParkedCar(12.3, 0.05, -8.7, 0.43, 0x654321,
    { length: 4.6, width: 1.9, idling: true });
  assert.deepEqual(car.position.toArray(), [12.3, 0.05, -8.7]);
  near(car.rotation.y, 0.43, 'Objective heading');
  assert.deepEqual(car.scale.toArray(), [1, 1, 1]);
  assert.deepEqual(h.World.children, [car], 'The returned car is the actual installed world object');
  assert.equal(car.children.length, 7, 'Each existing material category remains one draw');
  assert.equal(car.children.every(child => child.isMesh), true, 'The asset adds no live lights or per-part scene nodes');
  assert.deepEqual(h.lookupCalls, ['objective-sedan']);
  const meshes = byCategory(car, h.authored);
  for (const category of CATEGORIES) {
    const mesh = meshes[category];
    assert.equal(mesh.name, `objective-sedan-${category}`);
    assert.deepEqual(mesh.position.toArray(), [0, 0, 0], `${category}: authored vertices keep their local placement`);
    assert.deepEqual(mesh.rotation.toArray().slice(0, 3), [0, 0, 0]);
    assert.deepEqual(mesh.scale.toArray(), [1, 1, 1]);
    assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true);
    assert.equal(mesh.material.isMeshStandardMaterial, true);
    assert.equal(Array.isArray(mesh.material), false, 'Material buckets do not create hidden extra draws');
  }
  assert.equal(new Set(car.children.map(mesh => mesh.material)).size, 7);
  assert.equal(car.userData.authoredVehicle.variant, 'objective-sedan');
  assert.equal(car.userData.authoredVehicle.source, 'original-blender-prepared');
  assert.equal(car.userData.authoredVehicle.resources, h.authored.resources);
  assert.equal(car.userData.civilianVehicle, undefined, 'The mission car keeps its separate objective identity');
  checkColliders(h.colliderCalls, { x: 12.3, y: 0.05, z: -8.7, yaw: 0.43, length: 4.6, width: 1.9 });
});

test('repeated objectives share imported buffers without cloning, merging, mutation or disposal', () => {
  const authored = authoredFixture(), snapshots = new Map(), disposed = [];
  for (const [category, geometry] of Object.entries(authored.geometry)) {
    snapshots.set(category, Object.fromEntries(Object.entries(geometry.attributes)
      .map(([name, attribute]) => [name, Array.from(attribute.array)])));
    geometry.addEventListener('dispose', () => disposed.push(category));
    geometry.clone = () => assert.fail('Imported geometry is shared instead of cloned per objective');
    geometry.toNonIndexed = () => assert.fail('Imported geometry is already a renderable material bucket');
  }
  const h = harness({ authored, forbidProcedural: true });
  const first = h.spawnParkedCar(2, 0.05, 6, 0, 0x253647, { length: 4.6, width: 1.9 });
  const second = h.spawnParkedCar(-4, 0.14, 8, Math.PI, 0x8c321f, { length: 4.6, width: 1.9 });
  first.updateMatrixWorld(true); second.updateMatrixWorld(true);
  const firstParts = byCategory(first, authored), secondParts = byCategory(second, authored);
  for (const category of CATEGORIES) {
    assert.equal(firstParts[category].geometry, secondParts[category].geometry);
    assert.notEqual(firstParts[category].material, secondParts[category].material,
      `${category}: runtime material state belongs to its individual car`);
    for (const [name, values] of Object.entries(snapshots.get(category))) {
      assert.deepEqual(Array.from(authored.geometry[category].attributes[name].array), values,
        `${category}/${name}: world placement cannot alter shared local surface data`);
    }
  }
  assert.deepEqual(disposed, [], 'Scene construction cannot dispose buffers owned by the authored cache');
  assert.equal(h.World.children.length, 2);
});

test('authored surfaces retain runtime paint, transparent cabin and independent idle lamp intensities', () => {
  const h = harness({ forbidProcedural: true });
  const off = byCategory(h.spawnParkedCar(0, 0, 0, 0, 0x28394a,
    { length: 4.6, width: 1.9 }), h.authored);
  const idle = byCategory(h.spawnParkedCar(0, 0, 0, 0, 0x9a412b,
    { length: 4.6, width: 1.9, idling: true }), h.authored);
  assert.equal(off.paint.material.color.getHex(), 0x28394a);
  assert.equal(idle.paint.material.color.getHex(), 0x9a412b);
  for (const parts of [off, idle]) {
    for (const category of CATEGORIES) assert.equal(parts[category].material.vertexColors, false,
      `${category}: imported white colors must not change the runtime material shader contract`);
    assert.equal(parts.paint.material.roughness, 0.45); assert.equal(parts.paint.material.metalness, 0.6);
    assert.equal(parts.glass.material.transparent, true); assert.equal(parts.glass.material.opacity, 0.88);
    assert.equal(parts.glass.material.roughness, 0.19); assert.equal(parts.glass.material.metalness, 0.45);
    assert.equal(parts.tires.material.roughness, 0.95); assert.equal(parts.tires.material.metalness, 0);
    assert.equal(parts.metal.material.roughness, 0.25); assert.equal(parts.metal.material.metalness, 0.85);
    assert.equal(parts.headlamps.material.emissive.getHex(), 0xffe8a0);
    assert.equal(parts.rearlamps.material.emissive.getHex(), 0xa01818);
    for (const category of CATEGORIES.filter(category => category !== 'glass')) {
      assert.equal(parts[category].material.transparent, false, `${category}: preserve opaque render ordering`);
    }
  }
  assert.equal(off.headlamps.material.emissiveIntensity, 0.4);
  assert.equal(idle.headlamps.material.emissiveIntensity, 2.5);
  assert.equal(off.rearlamps.material.emissiveIntensity, 0.25);
  assert.equal(idle.rearlamps.material.emissiveIntensity, 1.4);
  idle.headlamps.material.emissiveIntensity = 0;
  assert.equal(off.headlamps.material.emissiveIntensity, 0.4, 'Changing one car cannot dim another car’s lamps');
});

test('the default, custom and near-matching dimensions retain the working procedural factory', () => {
  const cases = [
    [{}, 4.4, 1.8],
    [{ length: 4.6 }, 4.6, 1.8],
    [{ width: 1.9 }, 4.4, 1.9],
    [{ length: 5.1, width: 2.1 }, 5.1, 2.1],
    [{ length: 4.6 + 1e-10, width: 1.9 }, 4.6 + 1e-10, 1.9],
    [{ length: 4.6, width: 1.9 + 1e-10 }, 4.6, 1.9 + 1e-10],
  ];
  for (const [opts, length, width] of cases) {
    const h = harness();
    const car = h.spawnParkedCar(0, 0, 0, 0, 0x445566, opts);
    assert.deepEqual(h.lookupCalls, [], 'A fixed-size mesh must not replace a differently sized requested vehicle');
    assert.equal(car.userData.authoredVehicle, undefined);
    assert.equal(car.children.length, 7, 'The existing procedural material consolidation remains intact');
    assert.ok(car.children.every(mesh => mesh.isMesh && mesh.geometry.attributes.position.count > 0));
    assert.ok(car.children.every(mesh => !Object.values(h.authored.geometry).includes(mesh.geometry)));
    const bounds = new THREE.Box3().setFromObject(car, true), size = bounds.getSize(new THREE.Vector3());
    assert.ok(size.x > length && size.x < length + 0.4, 'Body, bumpers and lamps follow the requested length');
    assert.ok(size.z >= width && size.z < width + 0.4, 'Body, wheels and mirrors follow the requested width');
    checkColliders(h.colliderCalls, { x: 0, y: 0, z: 0, yaw: 0, length, width });
  }
});

test('cold fallback and authored geometry register identical rotated objective collision envelopes', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -0.37]) {
    const ready = harness(), cold = harness({ authored: null });
    const placement = { x: -13.7, y: 0.14, z: 24.3, yaw, length: 4.6, width: 1.9 };
    const opts = { length: 4.6, width: 1.9, idling: true };
    const before = cold.spawnParkedCar(placement.x, placement.y, placement.z, yaw, 0x465768, opts);
    const after = ready.spawnParkedCar(placement.x, placement.y, placement.z, yaw, 0x465768, opts);
    assert.deepEqual(cold.lookupCalls, ['objective-sedan']);
    assert.equal(before.userData.authoredVehicle, undefined);
    assert.equal(before.children.length, 7, 'A missing optional asset still creates a complete objective');
    assert.deepEqual(before.position.toArray(), after.position.toArray());
    assert.deepEqual(before.rotation.toArray(), after.rotation.toArray());
    assert.deepEqual(cold.colliderCalls, ready.colliderCalls, 'Visual asset availability cannot alter movement cover');
    checkColliders(ready.colliderCalls, placement);
  }
});
