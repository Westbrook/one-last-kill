import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Architecture, boxBounds, signYaw } from '../../src/world/architecture.js';
import { BUILDING, BALCONY, SCAFFOLD_LEVELS, OPENINGS } from '../../src/world/layout.js';

test('structural registry keeps intended bounds independent from live geometry', () => {
  Architecture.clear();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 2));
  mesh.position.set(2, 3.9, 1);
  const intended = boxBounds(2, 3.9, 1, 4, 0.2, 2);
  const collider = intended.clone();
  const record = Architecture.register(mesh, collider, intended, {
    id: 'deck', kind: 'deck', supports: ['beam'],
  });
  assert.equal(record.collider, collider);
  assert.equal(mesh.userData.architectureId, 'deck');
  const actual = new THREE.Box3().setFromObject(mesh);
  assert.ok(record.bounds.min.distanceTo(actual.min) < 1e-6);
  assert.ok(record.bounds.max.distanceTo(actual.max) < 1e-6);
  intended.translate(new THREE.Vector3(1, 0, 0));
  assert.ok(!record.bounds.equals(intended));
  mesh.position.y += 0.2;
  assert.ok(!record.bounds.equals(new THREE.Box3().setFromObject(mesh)));
  assert.deepEqual(record.supports, ['beam']);
  assert.throws(() => Architecture.register(mesh, null, collider, { id: 'deck' }), /duplicate/);
  assert.throws(() => Architecture.register(mesh, null, collider, {}), /Invalid/);
  Architecture.clear();
  assert.equal(Architecture.elements.size, 0);
  mesh.geometry.dispose(); mesh.material.dispose();
});

test('all sign directions point their painted front toward the named face', () => {
  const expected = { '+z': [0, 0, 1], '-z': [0, 0, -1], '+x': [1, 0, 0], '-x': [-1, 0, 0] };
  for (const [normal, vector] of Object.entries(expected)) {
    const direction = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), signYaw(normal));
    assert.ok(direction.distanceTo(new THREE.Vector3(...vector)) < 1e-12, normal);
  }
  assert.throws(() => signYaw('+y'), /Unsupported/);
});

test('the authored building envelope, openings and exterior platforms are immutable', () => {
  assert.equal(BUILDING.main.x2, BALCONY.east.x2);
  assert.equal(BUILDING.main.x1, BUILDING.tower.x2);
  assert.equal(BUILDING.apartmentY, BALCONY.floorY);
  assert.equal(BALCONY.east.z2, BALCONY.wrap.z1);
  for (const data of [BUILDING, BALCONY, SCAFFOLD_LEVELS, OPENINGS]) {
    assert.ok(Object.isFrozen(data));
    for (const child of Object.values(data)) {
      if (child && typeof child === 'object') assert.ok(Object.isFrozen(child));
    }
  }
  assert.throws(() => { BALCONY.wrap.z2 = 1.3; }, TypeError);
  assert.throws(() => { OPENINGS.balconyStair.min[1] = 0; }, TypeError);
});
