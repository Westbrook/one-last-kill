import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { loadAuthoredWorldDressing, getAuthoredWorldDressingStatus, createAuthoredWorldDressingGeometry, refineAuthoredDressingMesh } from '../../src/render/authored-world-dressing.js';
import { WATER_TANK_STAVE_UV } from '../../src/render/water-tank-uv.js';
import { buildWorldSurfaceFixture } from './helpers/world-surface-fixture.js';

const near = (actual, expected, label, epsilon = 1e-5) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} versus ${expected}`);
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const triangleCount = geometry => (geometry.index?.count ?? geometry.attributes.position.count) / 3;
const extent = values => new THREE.Box3().setFromPoints(Array.from({ length: values.length / 3 }, (_, i) =>
  new THREE.Vector3(values[i * 3], values[i * 3 + 1], values[i * 3 + 2])));

function checkGeometry(geometry, label) {
  const { position, normal, uv } = geometry.attributes;
  assert.ok(position && normal && uv, `${label}: complete static surface`);
  assert.equal(position.count, normal.count); assert.equal(position.count, uv.count);
  assert.equal(position.itemSize, 3); assert.equal(normal.itemSize, 3); assert.equal(uv.itemSize, 2);
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    assert.ok(attribute.array.every(Number.isFinite), `${label}: finite ${name}`);
  }
  assert.ok(geometry.index.array.every(index => Number.isInteger(index) && index >= 0 && index < position.count), `${label}: valid indices`);
  assert.equal(geometry.index.count % 3, 0);
  let usefulUVs = 0, signedVolume = 0;
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let i = 0; i < normal.count; i++) near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1, `${label}: unit normal`, 0.003);
  for (let i = 0; i < geometry.index.count; i += 3) {
    const [a, b, c] = [0, 1, 2].map(offset => geometry.index.getX(i + offset));
    va.fromBufferAttribute(position, a); vb.fromBufferAttribute(position, b); vc.fromBufferAttribute(position, c);
    ab.subVectors(vb, va); ac.subVectors(vc, va);
    const face = new THREE.Vector3().crossVectors(ab, ac);
    assert.ok(face.lengthSq() > 1e-20, `${label}: nondegenerate exported triangle ${i / 3}`);
    const shading = new THREE.Vector3(normal.getX(a) + normal.getX(b) + normal.getX(c),
      normal.getY(a) + normal.getY(b) + normal.getY(c), normal.getZ(a) + normal.getZ(b) + normal.getZ(c));
    assert.ok(face.dot(shading) > 0, `${label}: visible winding agrees with the surface normal`);
    signedVolume += va.dot(new THREE.Vector3().crossVectors(vb, vc)) / 6;
    const area = (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a))
      - (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a));
    if (Math.abs(area) > 1e-12) usefulUVs++;
  }
  assert.ok(signedVolume > 1e-9, `${label}: closed outward-facing surface`);
  assert.ok(usefulUVs >= triangleCount(geometry) * 0.99, `${label}: actual UV triangles retain surface area`);
}

function checkWorldUV(geometry, meters, offset) {
  const { position, normal, uv } = geometry.attributes;
  for (let i = 0; i < position.count; i++) {
    const point = [position.getX(i) + offset.x, position.getY(i) + offset.y, position.getZ(i) + offset.z];
    const direction = [Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i))];
    const expected = direction[0] >= direction[1] && direction[0] >= direction[2]
      ? [point[2], point[1]] : direction[1] >= direction[2] ? [point[0], point[2]] : [point[0], point[1]];
    near(uv.getX(i), expected[0] / meters, `physical U vertex ${i}`);
    near(uv.getY(i), expected[1] / meters, `physical V vertex ${i}`);
  }
}

test('the Blender world-dressing catalog preserves the existing static world contracts', async t => {
  const catalog = readJson('../../public/assets/models/world-dressing/catalog.json');
  const manifest = readJson('../../public/assets/models/world-dressing/manifest.json');
  const source = readJson('../../assets/blender/world-dressing-source.json');
  const original = buildWorldSurfaceFixture();

  await t.test('failed requests, malformed geometry, and timeout leave fallback usable until a shared retry succeeds', async () => {
    assert.equal(createAuthoredWorldDressingGeometry('water-tank-barrel', { dimensions: [1.4, 2.2, 48] }), null);
    const offline = await loadAuthoredWorldDressing({ loader: () => { throw new Error('offline fixture'); } });
    assert.equal(offline.state, 'fallback');
    for (const [label, damage] of [
      ['nonfinite position', value => { value.entries[0].positions[0] = NaN; }],
      ['invalid index', value => { value.entries[0].index[0] = value.entries[0].positions.length; }],
      ['escaped bounds', value => { value.entries[0].positions[0] = 1000; }],
    ]) {
      const invalid = copy(catalog); damage(invalid);
      const result = await loadAuthoredWorldDressing({ loader: async () => invalid });
      assert.equal(result.state, 'fallback', label);
      assert.equal(createAuthoredWorldDressingGeometry('hvac-body', { dimensions: [2.2, 1, 1.2] }), null,
        'A partially decoded catalog cannot leak into synchronous scene building');
    }
    let deliver;
    const expired = await loadAuthoredWorldDressing({ timeoutMs: 5, loader: () => new Promise(resolve => { deliver = resolve; }) });
    assert.equal(expired.state, 'fallback'); assert.match(expired.reason, /timed out/i);
    deliver(copy(catalog)); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(getAuthoredWorldDressingStatus().state, 'fallback', 'A late request cannot replace the active fallback');
    let loads = 0;
    const loader = async () => { loads++; return copy(catalog); };
    const ready = await Promise.all([loadAuthoredWorldDressing({ loader }), loadAuthoredWorldDressing({ loader })]);
    for (const result of ready) assert.equal(result.state, 'ready', result.reason);
    assert.equal(loads, 1, 'One boot decode serves simultaneous users');
    await loadAuthoredWorldDressing({ loader }); assert.equal(loads, 1);
    assert.equal(createAuthoredWorldDressingGeometry('missing-world-part'), null);
  });

  await t.test('each actual exported source retains its dimensions, bounded shape, and useful surface attributes', () => {
    assert.equal(source.entries.length, 28, 'The source includes all intended dressing variants');
    assert.equal(catalog.version, 1); assert.equal(catalog.source, 'original-blender-authored');
    assert.equal(catalog.materials, 0); assert.equal(catalog.textures, 0);
    const payload = readFileSync(new URL('../../public/assets/models/world-dressing/catalog.json', import.meta.url));
    assert.ok(payload.length <= 2 * 1024 * 1024,
      'Complete geometry payload stays below 2 MiB without runtime decoders');
    assert.equal(manifest.catalogBytes, payload.length);
    assert.equal(manifest.sha256, createHash('sha256').update(payload).digest('hex'));
    assert.equal(manifest.templateCount, source.entries.length);
    for (const field of ['addedDraws', 'addedMaterials', 'addedTextures', 'addedLights']) assert.equal(manifest[field], 0);
    assert.deepEqual(catalog.entries.map(entry => entry.id).sort(), source.entries.map(entry => entry.id).sort());
    let originalTriangles = 0, loadedTriangles = 0;
    for (const reference of source.entries) {
      const entry = catalog.entries.find(candidate => candidate.id === reference.id);
      assert.equal(entry.family, reference.family); assert.deepEqual(entry.dimensions, reference.dimensions);
      assert.equal(entry.instances, reference.instances); assert.equal(entry.sourceTriangles, reference.sourceTriangles);
      const geometry = createAuthoredWorldDressingGeometry(reference.family, { dimensions: reference.dimensions });
      assert.ok(geometry, `${reference.id}: exact authored dimension variant`);
      checkGeometry(geometry, reference.id);
      assert.equal(triangleCount(geometry), entry.triangles, `${reference.id}: measured exported count matches metadata`);
      originalTriangles += reference.instances * reference.sourceTriangles;
      loadedTriangles += reference.instances * triangleCount(geometry);
      const before = extent(reference.positions);
      geometry.computeBoundingBox();
      assert.ok(before.clone().expandByScalar(0.00002).containsBox(geometry.boundingBox), `${reference.id}: original spatial envelope`);
      const center = geometry.boundingBox.getCenter(new THREE.Vector3()), expectedCenter = before.getCenter(new THREE.Vector3());
      for (const axis of ['x', 'y', 'z']) near(center[axis], expectedCenter[axis], `${reference.id}: retained ${axis} origin`);
      assert.equal(geometry.groups.length, 0, 'One existing material owns the complete replacement');
      assert.deepEqual(geometry.morphAttributes, {});
      geometry.dispose();
    }
    assert.equal(manifest.sourcePlacedTriangles, originalTriangles); assert.equal(manifest.placedTriangles, loadedTriangles);
    assert.equal(manifest.triangleDelta, loadedTriangles - originalTriangles);
    assert.ok(loadedTriangles <= originalTriangles + 1200, `Actual placed dressing triangle budget: ${loadedTriangles} <= ${originalTriangles} + 1200`);
    assert.equal(createAuthoredWorldDressingGeometry('hvac-body', { dimensions: [2.2, 1, 999] }), null, 'Unknown dimensions use the original geometry');
  });

  await t.test('callers own independent buffers and physical UV placement never damages the cached source', () => {
    const options = { dimensions: [2.2, 1, 1.2] };
    const first = createAuthoredWorldDressingGeometry('hvac-body', options);
    const second = createAuthoredWorldDressingGeometry('hvac-body', options);
    assert.notEqual(first, second); assert.notEqual(first.index.array, second.index.array);
    for (const name of ['position', 'normal', 'uv']) assert.notEqual(first.attributes[name].array, second.attributes[name].array);
    const positions = second.attributes.position.array.slice(), uvs = second.attributes.uv.array.slice();
    first.translate(10, 20, 30); first.attributes.uv.setXY(0, 500, 600); first.dispose();
    assert.deepEqual(second.attributes.position.array, positions); assert.deepEqual(second.attributes.uv.array, uvs);
    const offset = { x: 14.2, y: -2.7, z: 3.6 }, meters = 0.3;
    const mapped = createAuthoredWorldDressingGeometry('hvac-body', { ...options, meters, offset });
    checkWorldUV(mapped, meters, offset);
    const fresh = createAuthoredWorldDressingGeometry('hvac-body', options);
    assert.deepEqual(fresh.attributes.position.array, positions); assert.deepEqual(fresh.attributes.uv.array, uvs);
    second.dispose(); mapped.dispose(); fresh.dispose();
  });

  await t.test('prepared cases and machinery have real edge breaks and the workbench handle has an open grip', () => {
    for (const [family, dimensions] of [['hvac-body', [2.2, 1, 1.2]], ['workbench-case', [0.58, 0.18, 0.38]]]) {
      const geometry = createAuthoredWorldDressingGeometry(family, { dimensions });
      const { normal } = geometry.attributes;
      let oblique = 0;
      for (let i = 0; i < normal.count; i++) {
        if ([normal.getX(i), normal.getY(i), normal.getZ(i)].filter(value => Math.abs(value) > 0.1).length >= 2) oblique++;
      }
      assert.ok(oblique >= 12, `${family}: light can catch physical beveled faces`);
      assert.ok(triangleCount(geometry) > 12, `${family}: edge detail survives export`);
      geometry.dispose();
    }
    const geometry = createAuthoredWorldDressingGeometry('workbench-handle', { dimensions: [0.22, 0.05, 0.07] });
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), mesh = new THREE.Mesh(geometry, material);
    mesh.updateMatrixWorld(true);
    const probe = (x, y) => new THREE.Raycaster(new THREE.Vector3(x, y, -0.1), new THREE.Vector3(0, 0, 1)).intersectObject(mesh);
    assert.equal(probe(0, -0.01).length, 0, 'The actual grip opening remains clear through the complete depth');
    assert.ok(probe(0, 0.018).length >= 2, 'The horizontal bridge is present');
    assert.ok(probe(0.095, -0.01).length >= 2, 'The supporting leg is present');
    geometry.dispose(); material.dispose();
  });

  await t.test('in-place refinement retains the mesh material, transform and collider while replacing only its owned box geometry', () => {
    const material = new THREE.MeshStandardMaterial(); material.userData.surfaceMeters = 0.3;
    const before = new THREE.BoxGeometry(2.2, 1, 1.2), mesh = new THREE.Mesh(before, material);
    mesh.position.set(12, 14.8, -8.8); mesh.rotation.y = 0.2;
    mesh.name = 'fixture-hvac'; mesh.castShadow = true; mesh.receiveShadow = true;
    const collider = new THREE.Box3(new THREE.Vector3(10.9, 14.3, -9.4), new THREE.Vector3(13.1, 15.3, -8.2));
    mesh.userData.collider = collider;
    const position = mesh.position.clone(), quaternion = mesh.quaternion.clone();
    let disposals = 0; before.addEventListener('dispose', () => disposals++);
    refineAuthoredDressingMesh(mesh, 'hvac-body');
    assert.notEqual(mesh.geometry, before); assert.equal(disposals, 1);
    assert.equal(mesh.material, material); assert.equal(mesh.userData.collider, collider);
    assert.ok(mesh.position.equals(position)); assert.ok(mesh.quaternion.equals(quaternion));
    assert.equal(mesh.name, 'fixture-hvac'); assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true);
    checkWorldUV(mesh.geometry, 0.3, position);
    const accepted = mesh.geometry;
    refineAuthoredDressingMesh(mesh, 'missing-part'); assert.equal(mesh.geometry, accepted);
    const unsupported = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 9), material), untouched = unsupported.geometry;
    refineAuthoredDressingMesh(unsupported, 'hvac-body'); assert.equal(unsupported.geometry, untouched);
    mesh.geometry.dispose(); unsupported.geometry.dispose(); material.dispose();
  });

  await t.test('the actual loaded world keeps collision, support registration, material ownership and mesh count', () => {
    const loaded = buildWorldSurfaceFixture();
    assert.equal(loaded.colliders.length, original.colliders.length);
    for (const [i, collider] of loaded.colliders.entries()) assert.ok(collider.equals(original.colliders[i]), `Collider ${i} remains unchanged`);
    assert.deepEqual([...loaded.records.keys()], [...original.records.keys()]);
    for (const [id, record] of loaded.records) {
      const previous = original.records.get(id);
      assert.ok(record.bounds.equals(previous.bounds), `${id}: registered envelope`);
      assert.deepEqual(record.supports, previous.supports, `${id}: retained support graph`);
      assert.equal(record.supportKind, previous.supportKind); assert.equal(record.kind, previous.kind);
    }
    assert.equal(loaded.entries.length, original.entries.length, 'Replacement does not add opaque or shadow draws');
    const materialCount = fixture => new Set(fixture.entries.flatMap(({ mesh }) => [].concat(mesh.material))).size;
    assert.equal(materialCount(loaded), materialCount(original), 'The full world does not gain material variants');
    const actualInstances = new Map();
    for (const { mesh } of loaded.entries) {
      const id = mesh.geometry.userData.authoredWorldDressing?.id;
      if (id) actualInstances.set(id, (actualInstances.get(id) || 0) + 1);
    }
    assert.equal(actualInstances.size, catalog.entries.length, 'Every authored template is actually selected by its production world builder');
    for (const entry of catalog.entries) assert.equal(actualInstances.get(entry.id), entry.instances, `${entry.id}: actual production placements`);
    const worldTriangles = fixture => fixture.entries.reduce((sum, { mesh }) => sum + triangleCount(mesh.geometry), 0);
    assert.equal(worldTriangles(loaded) - worldTriangles(original), manifest.triangleDelta,
      'Measured geometry change in the complete scene agrees with the placed resource budget');
    const tank = loaded.records.get('water-tank');
    assert.equal(tank.mesh.material, loaded.materials.get('wood'));
    assert.ok(tank.collider.equals(tank.bounds));
    assert.deepEqual(tank.supports, ['tank-cradle-0', 'tank-cradle-1']);
    assert.deepEqual(tank.mesh.position.toArray(), [-8, 17.3, -2]);
    assert.equal(tank.mesh.castShadow, true); assert.equal(tank.mesh.receiveShadow, true);
    assert.notDeepEqual(tank.mesh.geometry.attributes.position.array, original.records.get('water-tank').mesh.geometry.attributes.position.array,
      'The actual world selects the imported geometry after preload');
  });

  await t.test('the exported tank preserves vertical grain and two atlas repeats for 32 staves', () => {
    const tank = createAuthoredWorldDressingGeometry('water-tank-barrel', { dimensions: [1.4, 2.2, 48], meters: 0.3, offset: { x: 10, y: 20, z: 30 } });
    const { position, normal, uv } = tank.attributes;
    const sides = [];
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(normal.getY(i)) > 1e-5) continue;
      sides.push(i);
      const height = (position.getY(i) + 1.1) / 2.2;
      near(uv.getX(i), WATER_TANK_STAVE_UV.grainUMin + height * (WATER_TANK_STAVE_UV.grainUMax - WATER_TANK_STAVE_UV.grainUMin), `stave grain vertex ${i}`);
    }
    assert.ok(sides.length >= 96, 'Actual vertical barrel surfaces are present');
    const minV = Math.min(...sides.map(i => uv.getY(i))), maxV = Math.max(...sides.map(i => uv.getY(i)));
    near(maxV - minV, 2, 'Two circumferential repeats');
    near((maxV - minV) * 16, 32, 'Exactly 32 shared atlas stave rows');
    let verticalPairs = 0, closedSeams = 0;
    for (const a of sides) for (const b of sides) {
      if (a >= b || Math.hypot(position.getX(a) - position.getX(b), position.getZ(a) - position.getZ(b)) > 1e-5) continue;
      if (Math.abs(position.getY(a) - position.getY(b)) > 1) {
        const wrapped = Math.abs(uv.getY(a) - uv.getY(b));
        assert.ok(wrapped < 1e-5 || Math.abs(wrapped - 2) < 1e-5, 'Grain columns follow real vertical edges');
        verticalPairs++;
      } else if (Math.abs(uv.getY(a) - uv.getY(b)) > 1.9) closedSeams++;
    }
    assert.ok(verticalPairs >= 48); assert.ok(closedSeams >= 2, 'Both rim seams repeat without texture phase discontinuity');
    tank.dispose();
  });
});
