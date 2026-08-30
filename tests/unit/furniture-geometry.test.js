import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { furnitureBox, furnitureLeg, furniturePiping, furnitureCup, furnitureCupHandle } from '../../src/render/furniture-geometry.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

function inspectSurface(geometry) {
  const { position, normal, uv } = geometry.attributes;
  for (const attribute of [position, normal, uv]) assert.ok(attribute.array.every(Number.isFinite));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < normal.count; i++) near(n.fromBufferAttribute(normal, i).length(), 1);
  const count = geometry.index?.count ?? position.count;
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map(offset => geometry.index ? geometry.index.getX(i + offset) : i + offset);
    a.fromBufferAttribute(position, ids[0]); b.fromBufferAttribute(position, ids[1]); c.fromBufferAttribute(position, ids[2]);
    b.sub(a); c.sub(a); b.cross(c);
    assert.ok(b.lengthSq() > 1e-20, 'every authored face has visible area');
    assert.ok(b.dot(n.fromBufferAttribute(normal, ids[0])) > 0, 'winding faces outwards');
  }
}

test('milled edges and soft silhouettes keep their full contact bounds with bounded geometry', () => {
  for (const segments of [1, 2]) {
    const geometry = furnitureBox(1.4, 0.06, 0.9, 0.016, 0.6, segments);
    assert.equal(furnitureBox(1.4, 0.06, 0.9, 0.016, 0.6, segments), geometry, 'repeated authored shapes reuse one allocation');
    inspectSurface(geometry);
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    near(size.x, 1.4); near(size.y, 0.06); near(size.z, 0.9);
    assert.ok((geometry.index?.count ?? geometry.attributes.position.count) / 3 <= (segments === 1 ? 44 : 300));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
      const origin = new THREE.Vector3().setComponent(axis, sign * 2);
      const direction = new THREE.Vector3().setComponent(axis, -sign);
      const hit = new THREE.Raycaster(origin, direction).intersectObject(mesh)[0];
      assert.ok(hit, 'the closed body retains all six centre contact faces');
      near(hit.point.getComponent(axis), sign * [0.7, 0.03, 0.45][axis]);
    }
  }
});

test('fixture-normalized bevels preserve authored metric UV density', () => {
  const dimensions = [0.76, 1.1, 0.026];
  const actual = furnitureBox(...dimensions, 0.006, 0.3);
  const normalized = furnitureBox(...dimensions, 0.006, 0.3, 1, true);
  assert.deepEqual(normalized.attributes.uv.array, actual.attributes.uv.array);
  for (let i = 0; i < actual.attributes.position.count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      near(normalized.attributes.position.array[i * 3 + axis] * dimensions[axis], actual.attributes.position.array[i * 3 + axis]);
    }
  }
});

test('profiled legs have grounded caps and a smooth normal across their UV wrap', () => {
  const geometry = furnitureLeg(0.055, 0.39, 0.055);
  inspectSurface(geometry);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  for (const sign of [-1, 1]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(0, sign, 0), new THREE.Vector3(0, -sign, 0)).intersectObject(mesh)[0];
    near(hit.point.y, sign * 0.195);
  }
  const { position, normal, uv } = geometry.attributes;
  let wrapPairs = 0;
  for (let i = 0; i < position.count; i++) for (let j = i + 1; j < position.count; j++) {
    const p = new THREE.Vector3().fromBufferAttribute(position, i);
    const q = new THREE.Vector3().fromBufferAttribute(position, j);
    if (p.distanceToSquared(q) < 1e-16 && Math.abs(uv.getY(i) - uv.getY(j)) > 0.1) {
      const n = new THREE.Vector3().fromBufferAttribute(normal, i);
      const m = new THREE.Vector3().fromBufferAttribute(normal, j);
      near(n.dot(m), 1); wrapPairs++;
    }
  }
  assert.ok(wrapPairs >= 10, 'all loft levels retain smooth duplicated seam vertices');
});

test('opaque upholstery piping has outward faces in both attachment planes', () => {
  for (const plane of ['xy', 'xz']) {
    const geometry = furniturePiping(0.6, 0.4, 0.035, 0.0025, plane);
    inspectSurface(geometry);
    assert.equal(geometry.index.count / 3, 200);
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    assert.ok(size[plane === 'xy' ? 'z' : 'y'] < 0.0051);
  }
});

test('the ceramic cup has an open cavity and an exterior handle', () => {
  const material = new THREE.MeshBasicMaterial();
  const cup = new THREE.Mesh(furnitureCup(), material), handle = new THREE.Mesh(furnitureCupHandle(), material);
  handle.position.set(0.0392, 0.057, 0); handle.updateMatrixWorld();
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0.2, 0), new THREE.Vector3(0, -1, 0));
  near(ray.intersectObject(cup)[0].point.y, 0.015);
  assert.equal(ray.intersectObject(handle).length, 0);
  // The side of the cavity must stay empty too; a full torus formerly put its
  // inner crescent through this region above the cup's actual floor.
  for (const x of [0.015, 0.025, 0.03, 0.033]) {
    ray.ray.origin.x = x;
    const handleHit = ray.intersectObject(handle)[0];
    assert.equal(handleHit, undefined, `handle stays outside the bowl at x=${x}`);
  }
});
