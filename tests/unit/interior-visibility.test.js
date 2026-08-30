import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createInteriorVisibility } from '../../src/render/interior-visibility.js';

const room = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
const material = () => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });

test('static world-space bake rays match rendered triangles across rotated, scaled and instanced geometry', () => {
  const root = new THREE.Group(); root.position.set(0.3, -0.2, 0.4); root.rotation.y = 0.17;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), material());
  box.position.set(-1.8, 1, 0.5); box.rotation.set(0.2, -0.3, 0.1); box.scale.set(1.2, 0.7, 1.9); root.add(box);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material());
  plane.position.set(0, 1, 2); plane.rotation.y = 0.22; root.add(plane);
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 1, 0.8), material(), 3);
  const transform = new THREE.Object3D();
  for (let i = 0; i < 3; i++) {
    transform.position.set(i * 1.3, 0.5, -1); transform.rotation.y = i * 0.3;
    transform.scale.set(i === 1 ? -1 : 1, 1, 1); transform.updateMatrix(); instances.setMatrixAt(i, transform.matrix);
  }
  root.add(instances); root.updateMatrixWorld(true);
  const meshes = [box, plane, instances], visibility = createInteriorVisibility(meshes, [room]);
  let state = 42;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (let i = 0; i < 300; i++) {
    const origin = new THREE.Vector3((random() - 0.5) * 8, random() * 4, -4);
    const direction = new THREE.Vector3((random() - 0.5) * 3, (random() - 0.5) * 2, 4).normalize();
    const expected = new THREE.Raycaster(origin, direction, 1e-6, 12).intersectObjects(meshes)[0]?.distance ?? Infinity;
    const actual = visibility.distance(origin, direction, 12);
    assert.ok(actual === expected || Math.abs(actual - expected) < 1e-6, `${actual} matches ${expected}`);
    assert.equal(visibility.occluded(origin, direction, 12), expected !== Infinity);
  }
  visibility.clear();
});

test('real doorway triangles leave the opening clear and respect ray length', () => {
  const meshes = [-2, 2].map(x => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.2), material()); wall.position.set(x, 1.5, 0); return wall;
  });
  const header = new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 0.2), material()); header.position.set(0, 2.7, 0); meshes.push(header);
  const visibility = createInteriorVisibility(meshes, [room]), direction = new THREE.Vector3(0, 0, 1);
  assert.equal(visibility.occluded(new THREE.Vector3(0, 1, -2), direction, 5), false);
  assert.equal(visibility.occluded(new THREE.Vector3(2, 1, -2), direction, 1), false);
  assert.equal(visibility.occluded(new THREE.Vector3(2, 1, -2), direction, 5), true);
  assert.ok(Math.abs(visibility.distance(new THREE.Vector3(0, 2.7, -2), direction, 5) - 1.9) < 1e-6);
  visibility.clear();
});

test('draw ranges, nonindexed geometry and the live instance count bound occluders exactly', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -1, -1, 0, 1, -1, 0, 0, 1, 0,
    2, -1, 0, 4, -1, 0, 3, 1, 0,
  ], 3));
  geometry.setDrawRange(3, 3);
  const mesh = new THREE.Mesh(geometry, material());
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material(), 2);
  instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-3, 0, 0));
  instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, 0)); instances.count = 1;
  const visibility = createInteriorVisibility([mesh, instances], [room]), direction = new THREE.Vector3(0, 0, 1);
  assert.equal(visibility.occluded(new THREE.Vector3(0, 0, -2), direction, 4), false);
  assert.equal(visibility.occluded(new THREE.Vector3(3, 0, -2), direction, 4), true);
  assert.equal(visibility.occluded(new THREE.Vector3(-3, 0, -2), direction, 4), true);
  assert.equal(visibility.snapshot().triangles, 13);
  visibility.clear();
});

test('outside geometry is discarded and clearing drops all query buffers without touching source resources', () => {
  const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material());
  const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material()); far.position.x = 100;
  let disposed = 0; near.geometry.addEventListener('dispose', () => disposed++);
  const visibility = createInteriorVisibility([near, far], [room]);
  assert.equal(visibility.snapshot().triangles, 12);
  const origin = new THREE.Vector3(0, 0, -2), direction = new THREE.Vector3(0, 0, 1);
  assert.equal(visibility.occluded(origin, direction, 4), true);
  visibility.clear(); visibility.clear();
  assert.equal(visibility.distance(origin, direction, 4), Infinity);
  assert.equal(visibility.occluded(origin, direction, 4), false);
  assert.equal(disposed, 0);
});

test('micron-scale coplanar error does not self-shadow while the next physical face still occludes', () => {
  const seam = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material());
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material()); wall.position.z = 1;
  const visibility = createInteriorVisibility([seam, wall], [room]);
  const direction = new THREE.Vector3(0, 0, 1);
  assert.equal(visibility.occluded(new THREE.Vector3(0, 0, -0.000003), direction, 0.5), false);
  assert.ok(Math.abs(visibility.distance(new THREE.Vector3(0, 0, -0.000003), direction, 2) - 1.000003) < 1e-9);
  assert.equal(visibility.occluded(new THREE.Vector3(0, 0, -0.00002), direction, 0.5), true);
  visibility.clear();
});
