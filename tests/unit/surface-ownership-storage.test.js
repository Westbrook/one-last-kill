import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { resolveSurfaceOwnership } from '../../src/world/surface-ownership.js';

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≈ ${expected}`);
const methods = ['getX', 'getY', 'getZ'];
const decoded = attribute => Array.from({ length: attribute.count }, (_, index) =>
  methods.slice(0, attribute.itemSize).map(method => attribute[method](index)));

function fixture(encode) {
  const geometry = new THREE.BoxGeometry(4, 2, 4); encode(geometry);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); mesh.position.y = 1;
  const finish = new THREE.Mesh(new THREE.BoxGeometry(2, 0.25, 2), new THREE.MeshStandardMaterial()); finish.position.y = 1.875;
  const record = (id, kind, object) => {
    object.updateWorldMatrix(true, false); object.geometry.computeBoundingBox(); object.geometry.computeBoundingSphere();
    const bounds = new THREE.Box3().setFromObject(object);
    return { id, kind, mesh: object, bounds, collider: { min: bounds.min.clone(), max: bounds.max.clone() }, supports: [] };
  };
  return [record('wall', 'wall', mesh), record('tile', 'floor', finish)];
}

function sideHit(mesh) {
  mesh.updateWorldMatrix(true, false);
  const ray = new THREE.Raycaster(new THREE.Vector3(0.6, 1.3, 5), new THREE.Vector3(0, 0, -1), 0, 10);
  return ray.intersectObject(mesh, false).find(hit => hit.face.normal.z > 0.99 && Math.abs(hit.point.z - 2) < 1e-6);
}

function upwardArea(mesh) {
  const { index, attributes: { position } } = mesh.geometry;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i)); b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    b.sub(a).cross(c.sub(a));
    if (b.y > 0 && Math.abs(b.x) + Math.abs(b.z) < 1e-6) area += b.length() / 2;
  }
  return area;
}

test('normalized Uint8 UVs keep the original ray-sampled 0.65 value on untouched side triangles', () => {
  const records = fixture(geometry => {
    const original = geometry.attributes.uv;
    const packed = new THREE.Uint8BufferAttribute(new Uint8Array(original.count * 2), 2, true);
    for (let i = 0; i < original.count; i++) packed.setXY(i, original.getX(i), original.getY(i));
    geometry.setAttribute('uv', packed);
  });
  const mesh = records[0].mesh, source = mesh.geometry, original = source.attributes.uv;
  const rawBefore = Array.from(original.array), decodedBefore = decoded(original), before = sideHit(mesh);
  assert.ok(before); near(before.uv.x, 0.65, 'original normalized U'); near(before.uv.y, 0.65, 'original normalized V');
  resolveSurfaceOwnership(records);
  assert.notEqual(mesh.geometry, source); near(upwardArea(mesh), 12, 'the valid packed box is clipped');
  const after = sideHit(mesh); assert.ok(after, 'unchanged side is still drawn');
  near(after.uv.x, before.uv.x, 'copied U is decoded, not a byte near 166');
  near(after.uv.y, before.uv.y, 'copied V is decoded, not a byte near 166');
  const copied = decoded(mesh.geometry.attributes.uv).slice(0, original.count);
  assert.deepEqual(copied, decodedBefore, 'every original UV survives conversion');
  assert.equal(source.attributes.uv, original); assert.equal(original.normalized, true);
  assert.deepEqual(Array.from(original.array), rawBefore, 'source bytes remain packed and unchanged');
});

function assertDecodedPositionsPreserved(records, storageLabel) {
  const mesh = records[0].mesh, source = mesh.geometry, original = source.attributes.position;
  const decodedBefore = decoded(original), rawBefore = Array.from(original.array);
  const boundsBefore = [source.boundingBox.min.toArray(), source.boundingBox.max.toArray()];
  const before = sideHit(mesh); assert.ok(before);
  resolveSurfaceOwnership(records);
  const replacement = mesh.geometry.attributes.position;
  assert.notEqual(mesh.geometry, source); assert.ok(replacement.count > original.count, 'a partial clip adds vertices');
  assert.deepEqual(decoded(replacement).slice(0, original.count), decodedBefore, `${storageLabel}: all original decoded coordinates survive`);
  near(upwardArea(mesh), 12, `${storageLabel}: indexed surface area`);
  const after = sideHit(mesh); assert.ok(after, `${storageLabel}: unchanged side remains ray-visible`);
  assert.ok(after.point.distanceTo(before.point) < 1e-6);
  assert.deepEqual([mesh.geometry.boundingBox.min.toArray(), mesh.geometry.boundingBox.max.toArray()], boundsBefore);
  assert.equal(source.attributes.position, original); assert.deepEqual(Array.from(original.array), rawBefore);
}

test('Float16 positions are copied as decoded coordinates without exposing half-float storage bits', () => {
  const records = fixture(geometry => {
    const original = geometry.attributes.position;
    const half = new THREE.Float16BufferAttribute(new Uint16Array(original.count * 3), 3);
    for (let i = 0; i < original.count; i++) half.setXYZ(i, original.getX(i), original.getY(i), original.getZ(i));
    geometry.setAttribute('position', half);
  });
  assert.equal(records[0].mesh.geometry.attributes.position.isFloat16BufferAttribute, true);
  assertDecodedPositionsPreserved(records, 'Float16');
});

test('interleaved positions honor stride and offset and preserve every original decoded vertex', () => {
  const records = fixture(geometry => {
    const original = geometry.attributes.position;
    const storage = new Float32Array(original.count * 7);
    for (let i = 0; i < original.count; i++) storage.set([700 + i, -50 - i, 0, 0, 0, 900 + i, -900 - i], i * 7);
    const interleaved = new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(storage, 7), 3, 2);
    for (let i = 0; i < original.count; i++) interleaved.setXYZ(i, original.getX(i), original.getY(i), original.getZ(i));
    geometry.setAttribute('position', interleaved);
  });
  const attribute = records[0].mesh.geometry.attributes.position;
  assert.equal(attribute.isInterleavedBufferAttribute, true); assert.equal(attribute.data.stride, 7); assert.equal(attribute.offset, 2);
  assertDecodedPositionsPreserved(records, 'interleaved');
});
