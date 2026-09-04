import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Architecture, boxBounds, signYaw } from '../../src/world/architecture.js';
import { BUILDING, BALCONY, APARTMENT_DOORS } from '../../src/world/layout.js';
import { createInteriorProps } from '../../src/world/interior-props.js';
import { addCrtHousing } from '../../src/render/crt-housing.js';
import { createDoorAssemblies } from '../../src/world/door-assemblies.js';
import { Colliders, capsuleHasClearance } from '../../src/core/collision.js';
import { createBallisticWorld } from '../../src/core/ballistics.js';
import { loadAuthoredFurniture, getAuthoredFurnitureStatus } from '../../src/render/authored-furniture.js';
import { createInteriorLighting, INTERIOR_LIGHT_ROOMS } from '../../src/render/interior-lighting.js';

// Reuse the established CPU apartment harness and its actual room builders.
// Extract only the fixture function, leaving that file's tests unregistered.
const fixtureURL = new URL('./apartment-layout.test.js', import.meta.url);
const fixtureSource = readFileSync(fixtureURL, 'utf8');
const start = fixtureSource.indexOf('function buildApartments(');
const end = fixtureSource.indexOf('\nconst apartmentRoute', start);
assert.ok(start >= 0 && end > start, 'the shared apartment fixture remains available');
const buildApartments = runInNewContext(`${fixtureSource.slice(start, end).replaceAll('import.meta.url', 'fixtureURL')}\n;buildApartments;`, {
  assert, readFileSync, runInNewContext, URL, fixtureURL,
  THREE, mergeGeometries, Architecture, boxBounds, signYaw, BUILDING, BALCONY, APARTMENT_DOORS,
  createInteriorProps, createDoorAssemblies, addCrtHousing, Colliders, createBallisticWorld,
});

const baseline = buildApartments();
const catalog = JSON.parse(readFileSync(new URL('../../public/assets/models/furniture/catalog.json', import.meta.url), 'utf8'));
const loaded = await loadAuthoredFurniture({ fetchImpl: async () => ({ ok: true, json: async () => catalog }) });
assert.equal(loaded.state, 'ready', loaded.error);
const authored = buildApartments();
const near = (actual, expected, label, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) < tolerance,
  `${label}: ${actual} != ${expected}`);
const boundsOf = mesh => new THREE.Box3().setFromObject(mesh);
const meshesOf = fixture => {
  const meshes = [];
  fixture.World.traverse(mesh => { if (mesh.isMesh) meshes.push(mesh); });
  return meshes;
};
const trianglesOf = fixture => meshesOf(fixture).reduce((total, mesh) => total
  + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0);
const meshes = meshesOf(authored);

test('Blender indexing retains every previous baked room receiver and planar chart', async () => {
  const bake = fixture => createInteriorLighting(fixture.World, {
    zoneMeshes: { apartment: fixture.World.children, neighbor: fixture.World.children },
    rooms: INTERIOR_LIGHT_ROOMS.filter(room => room.id !== 'bakery'), texelsPerMeter: 0.5,
  });
  const previous = await bake(baseline), current = await bake(authored);
  try {
    assert.equal(current.snapshot().receivers, previous.snapshot().receivers);
    assert.equal(current.snapshot().charts, previous.snapshot().charts);
    let authoredReceivers = 0;
    for (let i = 0; i < authored.World.children.length; i++) {
      const oldMesh = baseline.World.children[i], mesh = authored.World.children[i];
      assert.equal(Boolean(mesh.userData.interiorLighting), Boolean(oldMesh.userData.interiorLighting),
        `${mesh.userData.architectureId || mesh.name || i} retains its baked diffuse fill`);
      if (mesh.userData.interiorLighting && mesh.geometry.userData.authoredFurniture) authoredReceivers++;
    }
    assert.ok(authoredReceivers >= 18, 'large furniture panels retain their original atlas receiver coverage');
  } finally { current.dispose(); previous.dispose(); }
});

function meshAt(position) {
  const point = new THREE.Vector3(...position);
  const matches = meshes.filter(mesh => mesh.position.distanceTo(point) < 1e-6);
  assert.equal(matches.length, 1, `one rendered member at ${position}`);
  return matches[0];
}

test('loaded furniture preserves all movement volumes and structural supports', () => {
  assert.equal(authored.boxes.length, 74);
  assert.equal([...authored.records.values()].filter(record => record.kind === 'furniture').length, 43);
  assert.equal(authored.records.size, baseline.records.size);
  for (let i = 0; i < authored.boxes.length; i++) {
    assert.ok(authored.boxes[i].equals(baseline.boxes[i]), `movement volume ${i} is unchanged`);
  }
  for (const [id, record] of authored.records) {
    const previous = baseline.records.get(id);
    assert.ok(previous, `${id} retains its structural identity`);
    assert.ok(record.bounds.equals(previous.bounds), `${id} retains its recorded bounds`);
    assert.deepEqual(Array.from(record.supports), Array.from(previous.supports), `${id} retains its supports`);
    if (!['furniture', 'partition', 'lintel'].includes(record.kind)) continue;
    const visible = boundsOf(record.mesh);
    assert.ok(visible.min.distanceTo(record.bounds.min) < 1e-5 && visible.max.distanceTo(record.bounds.max) < 1e-5,
      `${id} still visibly fills its structural envelope`);
    if (record.collider) assert.ok(record.collider.equals(record.bounds), `${id} matches its collider`);
    assert.ok(record.supports.length > 0);
    for (const supportId of record.supports) {
      const support = authored.records.get(supportId);
      assert.ok(support, `${id} support ${supportId} exists`);
      assert.ok(record.bounds.clone().expandByScalar(0.002).intersectsBox(support.bounds), `${id} touches ${supportId}`);
      if (record.supportKind === 'bearing') near(record.bounds.min.y, support.bounds.max.y, `${id} rests on ${supportId}`);
    }
  }
  assert.ok(authored.decorations.every(mesh => !mesh.userData.collider), 'decorative parts create no movement bodies');
});

test('the real apartment builders use Blender templates across every furniture family with fewer triangles', () => {
  const families = {
    refrigerator: authored.records.get('apartment-refrigerator').mesh,
    stove: authored.records.get('apartment-stove').mesh,
    sideboard: authored.records.get('apartment-bedside').mesh,
    bookcase: authored.records.get('apartment-bedroom-storage').mesh,
    bench: authored.records.get('apartment-entry-bench').mesh,
    upholsteredSeat: authored.records.get('apartment-loveseat').mesh,
    bedding: authored.World.getObjectByName('apartment-mattress'),
    chair: meshAt([1.7, 4.415, -5]),
    tableSetting: meshAt([-9.71, 4.49, -4.96]),
  };
  for (const [family, mesh] of Object.entries(families)) {
    assert.equal(mesh.geometry.userData.authoredFurniture?.source, 'original-blender-authored', `${family} uses its loaded template`);
  }
  const used = new Set(meshes.map(mesh => mesh.geometry.userData.authoredFurniture?.template).filter(Boolean));
  assert.deepEqual([...used].sort(), ['cup', 'cup-handle', 'knob', 'milled-box', 'profiled-leg', 'soft-box']);
  assert.deepEqual(getAuthoredFurnitureStatus().usedTemplates.sort(), [...used].sort());
  const previous = trianglesOf(baseline), current = trianglesOf(authored);
  assert.ok(current < previous, `${current} apartment triangles remain below the ${previous} fallback triangles`);
  assert.ok(current < 29486, 'the asset path stays below the previous full apartment fixture count');
});

test('loaded decoration retains material sharing and adds no room lights', () => {
  const lightCount = fixture => {
    let count = 0;
    fixture.World.traverse(object => { if (object.isPointLight) count++; });
    return count;
  };
  assert.equal(lightCount(baseline), 5);
  assert.equal(lightCount(authored), 5);
  assert.equal(authored.decorations.length, baseline.decorations.length);
  // Material identities define the production per-zone merge buckets. Compare
  // the complete reuse pattern, including separately tinted upholstery.
  const materialPattern = fixture => {
    const materials = new Map();
    return Array.from(fixture.decorations, mesh => {
      if (!materials.has(mesh.material)) materials.set(mesh.material, materials.size);
      return [materials.get(mesh.material), mesh.material.name, mesh.material.transparent,
        mesh.material.opacity, mesh.material.depthWrite, mesh.material.userData.surfaceMeters ?? null];
    });
  };
  assert.deepEqual(materialPattern(authored), materialPattern(baseline));
  for (let i = 0; i < authored.decorations.length; i++) {
    const mesh = authored.decorations[i], previous = baseline.decorations[i];
    assert.ok(mesh.position.equals(previous.position) && mesh.scale.equals(previous.scale)
      && mesh.rotation.equals(previous.rotation), `decoration ${i} retains its placement and merge zone`);
    assert.deepEqual(Object.keys(mesh.geometry.attributes).sort(), ['normal', 'position', 'uv'],
      'all required appearance attributes survive the production decoration merger');
  }
});

test('the Blender mattress supports its pillow and every piping loop remains seated', () => {
  const pillow = authored.World.getObjectByName('apartment-pillow');
  const mattress = authored.World.getObjectByName('apartment-mattress');
  const pillowBounds = boundsOf(pillow), mattressBounds = boundsOf(mattress);
  near(pillowBounds.min.y, mattressBounds.max.y, 'pillow base meets mattress top');
  const ray = new THREE.Raycaster(new THREE.Vector3(pillow.position.x, pillowBounds.min.y + 0.01, pillow.position.z), new THREE.Vector3(0, -1, 0));
  near(ray.intersectObject(mattress)[0]?.point.y, pillowBounds.min.y, 'actual mattress support triangle');
  const padding = meshes.filter(mesh => mesh.geometry.type === 'FurnitureRoundedBoxGeometry');
  const loops = authored.decorations.filter(mesh => mesh.geometry.userData.furnitureShape?.kind === 'piping');
  assert.equal(loops.length, 12);
  const point = new THREE.Vector3(), direction = new THREE.Vector3();
  for (const loop of loops) {
    const backing = padding.filter(mesh => boundsOf(mesh).containsPoint(loop.position));
    assert.equal(backing.length, 1, 'each piping loop has one actual upholstered backing');
    assert.equal(backing[0].geometry.userData.authoredFurniture?.template, 'soft-box');
    const positions = loop.geometry.attributes.position, plane = loop.geometry.userData.furnitureShape.plane;
    for (let first = 0; first < positions.count; first += 6) {
      let min = Infinity, max = -Infinity;
      for (let side = 0; side < 6; side++) {
        point.fromBufferAttribute(positions, first + side).applyMatrix4(loop.matrixWorld);
        if (plane === 'xy') direction.set(0, 0, 1);
        else direction.set(point.x - loop.position.x, 0, point.z - loop.position.z).normalize();
        ray.ray.origin.copy(point).addScaledVector(direction, 0.1);
        ray.ray.direction.copy(direction).negate();
        const contact = ray.intersectObject(backing[0])[0];
        assert.ok(contact, 'each piping section has a rendered supporting surface');
        const distance = point.clone().sub(contact.point).dot(direction);
        min = Math.min(min, distance); max = Math.max(max, distance);
      }
      assert.ok(min < -0.0002 && max > 0.0002, `piping is attached and visible: ${min}, ${max}`);
    }
  }
});

const ballistics = createBallisticWorld({ colliders: Colliders });
ballistics.rebuild(authored.World);
function assertSolid(start, end, mesh, axis, contacts) {
  for (const [side, [a, b]] of [[start, end], [end, start]].entries()) {
    const origin = new THREE.Vector3(...a), target = new THREE.Vector3(...b);
    const direction = target.clone().sub(origin).normalize();
    const hit = ballistics.raycast(origin, direction, origin.distanceTo(target), 'bullet');
    assert.ok(hit, 'the member remains solid from both sides');
    assert.equal(hit.object, mesh); assert.equal(hit.material, mesh.material);
    near(hit.point[axis], contacts[side], 'contact follows the rendered member');
    near(hit.normal.length(), 1, 'contact normal is normalized');
    assert.ok(hit.normal.dot(direction) < -0.99, 'contact normal faces the incoming ray');
    for (const channel of ['bullet', 'sight']) assert.equal(ballistics.segmentOccluded(origin, target, channel), true);
  }
}

test('Blender chair seats, backs and all four profiled legs preserve exact ballistic contacts', () => {
  for (const [x, facing] of [[1.7, 1], [4.3, -1]]) {
    const backX = x - facing * 0.19;
    assertSolid([x, 4.415, -5.6], [x, 4.415, -4.4], meshAt([x, 4.415, -5]), 'z', [-5.2, -4.8]);
    assertSolid([backX - 0.35, 4.82, -5], [backX + 0.35, 4.82, -5], meshAt([backX, 4.72, -5]), 'x', [backX - 0.025, backX + 0.025]);
    for (const dx of [-0.15, 0.15]) for (const dz of [-0.15, 0.15]) {
      const legX = x + dx, z = -5 + dz;
      const mesh = meshAt([legX, 4.195, z]);
      assert.equal(mesh.geometry.userData.authoredFurniture?.template, 'profiled-leg');
      assertSolid([legX, 4.195, z - 0.12], [legX, 4.195, z + 0.12], mesh, 'z', [z - 0.0275, z + 0.0275]);
    }
  }
});

test('Blender furniture preserves the open chair shooting lanes and the metre-wide exit routes', () => {
  for (const x of [1.7, 4.3]) for (const y of [4.195, 4.6]) {
    const start = new THREE.Vector3(x, y, -5.6), end = new THREE.Vector3(x, y, -4.4);
    for (const [a, b] of [[start, end], [end, start]]) {
      assert.equal(ballistics.raycast(a, b.clone().sub(a).normalize(), a.distanceTo(b), 'bullet'), null);
      for (const channel of ['bullet', 'sight']) assert.equal(ballistics.segmentOccluded(a, b, channel), false);
    }
  }
  const routes = [[[-9, -4], [-8.5, -4], [-8.5, -6], [-4, -6]],
    [[-0.6, -6], [-0.1, -4.2], [1.9, -3.8], [5.6, -3.8], [5.6, -5.5], [8.5, -5.5]]];
  for (const route of routes) for (let i = 1; i < route.length; i++) {
    const start = new THREE.Vector3(route[i - 1][0], 4.02, route[i - 1][1]);
    const end = new THREE.Vector3(route[i][0], 4.02, route[i][1]), steps = Math.ceil(start.distanceTo(end) / 0.08);
    for (let step = 0; step <= steps; step++) {
      assert.ok(capsuleHasClearance(start.clone().lerp(end, step / steps), 0.5, 1.84, authored.boxes));
    }
  }
});

test('the placed Blender cup retains its open cavity, outside handle and tabletop support', () => {
  const cup = meshAt([-9.71, 4.49, -4.96]), handle = meshAt([-9.6708, 4.547, -4.96]);
  assert.equal(cup.geometry.userData.authoredFurniture?.template, 'cup');
  assert.equal(handle.geometry.userData.authoredFurniture?.template, 'cup-handle');
  const coaster = meshAt([-9.71, 4.485, -4.96]);
  near(boundsOf(cup).min.y, boundsOf(coaster).max.y, 'cup rests on the coaster');
  const ray = new THREE.Raycaster(cup.position.clone().add(new THREE.Vector3(0, 0.2, 0)), new THREE.Vector3(0, -1, 0));
  near(ray.intersectObject(cup)[0]?.point.y, cup.position.y + 0.015, 'open cavity floor');
  for (const x of [0, 0.015, 0.025, 0.03, 0.033]) {
    ray.ray.origin.x = cup.position.x + x;
    assert.equal(ray.intersectObject(handle).length, 0, `handle stays outside the bowl at x=${x}`);
  }
});
