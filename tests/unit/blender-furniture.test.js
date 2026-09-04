import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { loadAuthoredFurniture, getAuthoredFurnitureStatus, createAuthoredFurnitureGeometry } from '../../src/render/authored-furniture.js';
import { furnitureBox, furnitureLeg, furnitureKnob, furnitureCup, furnitureCupHandle } from '../../src/render/furniture-geometry.js';

const bytes = readFileSync(new URL('../../public/assets/models/furniture/catalog.json', import.meta.url));
const catalog = JSON.parse(bytes), manifest = JSON.parse(readFileSync(new URL('../../public/assets/models/furniture/manifest.json', import.meta.url)));
const fetchCatalog = async () => ({ ok: true, json: async () => globalThis.structuredClone(catalog) });
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const fallback = furnitureBox(0.7, 0.08, 0.6, 0.03, 0.3, 2);
await loadAuthoredFurniture({ fetchImpl: fetchCatalog });

function inspect(geometry) {
  const { position, normal, uv } = geometry.attributes;
  for (const attribute of [position, normal, uv]) assert.ok(attribute.array.every(Number.isFinite));
  for (let i = 0; i < normal.count; i++) near(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)), 1);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < geometry.index.count; i += 3) {
    const ids = [0, 1, 2].map(offset => geometry.index.getX(i + offset));
    a.fromBufferAttribute(position, ids[0]); b.fromBufferAttribute(position, ids[1]); c.fromBufferAttribute(position, ids[2]);
    b.sub(a); c.sub(a); b.cross(c);
    assert.ok(b.lengthSq() > 1e-20, 'every exported triangle has area');
    assert.ok(b.dot(n.fromBufferAttribute(normal, ids[0])) > 0, 'winding faces outward');
  }
}

test('furniture catalog matches its Blender manifest and retains zero runtime material/texture overhead', () => {
  assert.equal(bytes.length, manifest.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.ok(bytes.length < 40 * 1024);
  const loaded = getAuthoredFurnitureStatus();
  assert.equal(loaded.state, 'ready'); assert.equal(loaded.templates, 6);
  assert.equal(loaded.materials, 0); assert.equal(loaded.textures, 0);
  assert.ok(loaded.geometryBytes < 20 * 1024);
  for (const [name, template] of Object.entries(catalog.templates)) {
    assert.equal(template.index.length / 3, manifest.templates[name].triangles);
    assert.equal(template.position.length / 3, manifest.templates[name].vertices);
  }
});

test('loaded boxes cover arbitrary exact dimensions, centred contact faces and current primitive caps', () => {
  for (const dimensions of [[1.4, 0.06, 0.9], [0.025, 0.55, 0.020], [0.03, 0.021, 1.08], [2.3, 0.5, 0.95]]) {
    for (const segments of [1, 2]) {
      const shape = furnitureBox(...dimensions, 0.035, 0.6, segments);
      assert.equal(shape.userData.authoredFurniture.source, 'original-blender-authored');
      assert.equal(furnitureBox(...dimensions, 0.035, 0.6, segments), shape);
      assert.ok(shape.index.count / 3 <= (segments === 1 ? 44 : 300));
      inspect(shape);
      const size = shape.boundingBox.getSize(new THREE.Vector3());
      dimensions.forEach((value, axis) => near(size.getComponent(axis), value));
      const mesh = new THREE.Mesh(shape, new THREE.MeshBasicMaterial());
      for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
        const origin = new THREE.Vector3().setComponent(axis, sign * 3), direction = new THREE.Vector3().setComponent(axis, -sign);
        const contact = new THREE.Raycaster(origin, direction).intersectObject(mesh)[0];
        assert.ok(contact); near(contact.point.getComponent(axis), sign * dimensions[axis] / 2);
      }
    }
  }
});

test('metric UVs survive normalized fixture placement and imported cache owns its buffers', () => {
  const dimensions = [0.76, 1.1, 0.026];
  const physical = furnitureBox(...dimensions, 0.006, 0.3), unit = furnitureBox(...dimensions, 0.006, 0.3, 1, true);
  assert.deepEqual(unit.attributes.uv.array, physical.attributes.uv.array);
  for (let i = 0; i < physical.attributes.position.count; i++) for (let axis = 0; axis < 3; axis++) {
    near(unit.attributes.position.array[i * 3 + axis] * dimensions[axis], physical.attributes.position.array[i * 3 + axis]);
  }
  const first = createAuthoredFurnitureGeometry('soft-box'), second = createAuthoredFurnitureGeometry('soft-box');
  const saved = second.attributes.position.array.slice();
  first.translate(100, 100, 100); first.dispose();
  assert.deepEqual(second.attributes.position.array, saved);
  assert.notEqual(fallback, furnitureBox(0.7, 0.08, 0.6, 0.03, 0.3, 2), 'late successful preload never reuses an earlier procedural cache entry');
});

test('authored leg collars, bowl cavity and handles retain their contact/clearance contracts', () => {
  const leg = furnitureLeg(0.055, 0.39, 0.055), material = new THREE.MeshBasicMaterial();
  inspect(leg); inspect(furnitureKnob()); inspect(furnitureCup()); inspect(furnitureCupHandle());
  assert.equal(leg.index.count / 3, 156);
  const legMesh = new THREE.Mesh(leg, material);
  for (const sign of [-1, 1]) {
    const top = new THREE.Raycaster(new THREE.Vector3(0, sign, 0), new THREE.Vector3(0, -sign, 0)).intersectObject(legMesh)[0];
    near(top.point.y, sign * 0.195);
    const collar = new THREE.Raycaster(new THREE.Vector3(0, 0, sign), new THREE.Vector3(0, 0, -sign)).intersectObject(legMesh)[0];
    near(collar.point.z, sign * 0.0275);
  }
  const cup = new THREE.Mesh(furnitureCup(), material), handle = new THREE.Mesh(furnitureCupHandle(), material);
  handle.position.set(0.0392, 0.057, 0); handle.updateMatrixWorld();
  for (const x of [0, 0.015, 0.025, 0.03, 0.033]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 0.2, 0), new THREE.Vector3(0, -1, 0));
    near(ray.intersectObject(cup)[0].point.y, 0.015);
    assert.equal(ray.intersectObject(handle).length, 0);
  }
});

test('malformed catalogs fail atomically and a corrected retry recovers without scene resources', async () => {
  const api = await import('../../src/render/authored-furniture.js?invalid-test');
  const invalid = globalThis.structuredClone(catalog); invalid.templates['soft-box'].normal[0] = 12;
  const failed = await api.loadAuthoredFurniture({ fetchImpl: async () => ({ ok: true, json: async () => invalid }) });
  assert.equal(failed.state, 'fallback'); assert.match(failed.error, /normal/);
  assert.equal(api.createAuthoredFurnitureGeometry('milled-box'), null);
  const ready = await api.loadAuthoredFurniture({ fetchImpl: fetchCatalog });
  assert.equal(ready.state, 'ready');
});

test('catalog timeout aborts once and delayed completion cannot replace fallback state', async () => {
  const api = await import('../../src/render/authored-furniture.js?timeout-test');
  let complete, aborted = false, requests = 0;
  const fetchImpl = (_, { signal }) => {
    requests++; signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(resolve => { complete = resolve; });
  };
  const first = api.loadAuthoredFurniture({ fetchImpl, timeoutMs: 2 });
  const second = api.loadAuthoredFurniture({ fetchImpl, timeoutMs: 2 });
  assert.deepEqual(await first, await second); assert.equal(requests, 1); assert.ok(aborted);
  complete({ ok: true, json: async () => globalThis.structuredClone(catalog) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(api.getAuthoredFurnitureStatus().state, 'fallback');
  assert.equal(api.createAuthoredFurnitureGeometry('cup'), null);
});
